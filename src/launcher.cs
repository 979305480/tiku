// 题库.exe 启动器
// 作用：0) 单实例守卫 1) 起一个只监听 127.0.0.1 的迷你 HTTP 服务 2) 用 Edge/Chrome 的 --app 模式打开界面
// 目标框架：.NET Framework 4.8（Win11 自带，无需任何运行库）
// 编译：csc /target:winexe /codepage:65001 /r:System.Windows.Forms.dll
//
// 🔴 生命周期为什么用心跳而不是 WaitForExit：
//    Edge 启动时会做进程交接，Process.Start 拿到的句柄可能几百毫秒就退出，
//    WaitForExit() 会提前返回、把服务关掉，页面就变成「无法访问」。（踩过）
//    现在改成：页面每 2 秒 GET /api/alive 报到，关闭时 sendBeacon /api/bye；
//    两个信号都没有才靠超时兜底。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class TiKu
{
    const int FIXED_PORT = 45871;
    const string MUTEX_NAME = @"Local\TiKu_SingleInstance_v1";
    const int PING_TIMEOUT_SEC = 150;      // 心跳超时（浏览器最小化时节流到 1 次/分钟，所以给足）
    const int FIRST_WAIT_SEC = 30;         // 等页面首次连接

    static string BaseDir, AppDir, BankDir, StateDir, ProfileDir, LogPath;
    static TcpListener Server;
    static volatile bool Running = true;
    static volatile bool SeenPing = false;
    static volatile bool Bye = false;
    static DateTime LastPing = DateTime.MinValue;
    static int Port;
    // 🔴 每次启动生成一个随机令牌，页面必须带对令牌才能「报到 / 告别」。
    //    没有它的话，上一次会话残留的旧标签页被回收时会发 /api/bye，把新服务误杀。（踩过）
    static volatile string Token = "";

    [STAThread]
    static void Main()
    {
        bool createdNew;
        Mutex mutex = new Mutex(true, MUTEX_NAME, out createdNew);

        try
        {
            BaseDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            AppDir = Path.Combine(BaseDir, "app");
            BankDir = Path.Combine(BaseDir, "题库");
            StateDir = Path.Combine(BaseDir, "进度");
            ProfileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TiKu", "profile");
            LogPath = Path.Combine(StateDir, "启动日志.txt");

            Log("=== 启动 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ===");
            Log("目录: " + BaseDir);

            string browser = FindBrowser();
            Log("浏览器: " + (browser == null ? "(没找到)" : browser));

            if (!createdNew)
            {
                // 🔴 不能只信互斥体。上一次的进程有可能因为残留前台线程没真正死掉（僵尸），
                //    这时端口是死的，只开窗口只会得到「无法访问」。先探一下端口再决定。
                if (!PortAlive(FIXED_PORT))
                {
                    Log("互斥体被占但端口 " + FIXED_PORT + " 不通 → 判定为僵尸进程，按新实例启动");
                }
                else
                {
                    string tok = "";
                    try { tok = File.ReadAllText(Path.Combine(StateDir, "会话令牌.txt")).Trim(); } catch { }
                    Log("已有实例在跑 → 只再开一个窗口（令牌:" + (tok.Length > 0 ? "有" : "无") + "）");
                    LaunchBrowser(browser, "http://127.0.0.1:" + FIXED_PORT + "/" + (tok.Length > 0 ? "?t=" + tok : ""));
                    return;
                }
            }
            if (browser == null)
            {
                MessageBox.Show("没找到 Edge 或 Chrome。\n\n题库的界面需要其中之一来显示（Windows 11 自带 Edge，正常不会缺）。",
                    "题库 - 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (!Directory.Exists(AppDir))
            {
                MessageBox.Show("安装不完整：找不到 app 文件夹。\n\n请把整个 TiKu 文件夹一起拷贝，不要只拷 exe。",
                    "题库 - 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            Directory.CreateDirectory(StateDir);
            LoadConfig();                          // 题库目录可能被用户改过，先读配置
            Directory.CreateDirectory(BankDir);
            Directory.CreateDirectory(ProfileDir);

            Token = Guid.NewGuid().ToString("N").Substring(0, 10);
            try { File.WriteAllText(Path.Combine(StateDir, "会话令牌.txt"), Token); } catch { }

            Port = PickPort();
            Server = new TcpListener(IPAddress.Loopback, Port);
            Server.Start();
            Log("服务已启动 → http://127.0.0.1:" + Port + "/");

            Thread t = new Thread(AcceptLoop);
            t.IsBackground = true;
            t.Start();

            LaunchBrowser(browser, "http://127.0.0.1:" + Port + "/?t=" + Token);
            Log("已拉起浏览器窗口（令牌 " + Token + "）");

            DateTime deadline = DateTime.Now.AddSeconds(FIRST_WAIT_SEC);
            while (DateTime.Now < deadline && !SeenPing && !Bye) Thread.Sleep(150);
            Log(SeenPing ? "✅ 界面已连接" : "⚠️ " + FIRST_WAIT_SEC + " 秒内没收到界面心跳");

            if (!SeenPing && !Bye)
            {
                MessageBox.Show("界面没能连上本地服务（端口 " + Port + "）。\n\n" +
                    "常见原因：安全软件拦了本地端口。\n" +
                    "详情见：进度\\启动日志.txt",
                    "题库 - 界面打不开", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            while (Running)
            {
                Thread.Sleep(1000);
                // 🔴 告别信号不能立刻生效。Edge 复用浏览器进程时，上一次的旧窗口也会发 bye，
                //    当场退出会让新实例起来十几秒就自己没了（实测踩过两次）。
                //    现在要求「收到 bye 后心跳也停够 6 秒」才算真关窗。
                if (Bye && (DateTime.Now - LastPing).TotalSeconds > 6)
                {
                    Log("页面已关闭（心跳停 6 秒）→ 退出"); break;
                }
                if (SeenPing && (DateTime.Now - LastPing).TotalSeconds > PING_TIMEOUT_SEC)
                {
                    Log("心跳超时 " + PING_TIMEOUT_SEC + " 秒 → 退出"); break;
                }
                if (!SeenPing && DateTime.Now > deadline.AddSeconds(30))
                {
                    Log("始终没连上 → 退出"); break;
                }
            }
        }
        catch (Exception ex)
        {
            Log("❌ " + ex.GetType().Name + ": " + ex.Message);
            MessageBox.Show("题库启动失败：\n\n" + ex.Message, "题库 - 出错",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            Running = false;
            try { if (Server != null) Server.Stop(); } catch { }
            try { if (createdNew) mutex.ReleaseMutex(); } catch { }
            Log("=== 退出 " + DateTime.Now.ToString("HH:mm:ss") + " ===" + Environment.NewLine);
            // 🔴 必须硬退。曾经出现过「日志写了退出、进程却还活着」的僵尸：
            //    残留的前台线程（FolderBrowserDialog 的 STA 线程）会拖住进程不放，
            //    下一个实例看到互斥体被占就只开个空窗口指向死掉的服务。
            Environment.Exit(0);
        }
    }

    static void Log(string s)
    {
        try
        {
            Directory.CreateDirectory(StateDir);
            File.AppendAllText(LogPath, s + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    // ---------- 浏览器 ----------

    static Process LaunchBrowser(string browser, string url)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = browser;
        psi.Arguments = "--app=" + url
            + " --user-data-dir=\"" + ProfileDir + "\""
            + " --no-first-run --no-default-browser-check"
            + " --disable-background-mode --disable-sync --disable-extensions"
            + " --window-size=1200,880";
        psi.UseShellExecute = false;
        psi.WorkingDirectory = BaseDir;
        try { return Process.Start(psi); }
        catch (Exception ex) { Log("拉起浏览器失败: " + ex.Message); return null; }
    }

    static string FindBrowser()
    {
        string[] cands = new string[]
        {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        };
        foreach (string c in cands) if (File.Exists(c)) return c;

        string[] keys = new string[]
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        };
        foreach (string k in keys)
        {
            try
            {
                RegistryKey rk = Registry.LocalMachine.OpenSubKey(k);
                if (rk == null) continue;
                object v = rk.GetValue("");
                if (v != null && File.Exists(v.ToString())) return v.ToString();
            }
            catch { }
        }
        return null;
    }

    static int PickPort()
    {
        for (int p = FIXED_PORT; p < FIXED_PORT + 30; p++)
        {
            try
            {
                TcpListener probe = new TcpListener(IPAddress.Loopback, p);
                probe.Start();
                probe.Stop();
                return p;
            }
            catch { }
        }
        return FIXED_PORT;
    }

    // 端口上有没有活着的服务 —— 用来识破「僵尸进程占着互斥体但服务已死」
    static bool PortAlive(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(800)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    // ---------- 迷你 HTTP 服务 ----------

    static void AcceptLoop()
    {
        while (Running)
        {
            TcpClient c;
            try { c = Server.AcceptTcpClient(); }
            catch { break; }
            ThreadPool.QueueUserWorkItem(new WaitCallback(Handle), c);
        }
    }

    static void Handle(object state)
    {
        TcpClient c = (TcpClient)state;
        try
        {
            using (c)
            using (NetworkStream ns = c.GetStream())
            {
                c.ReceiveTimeout = 15000;
                string reqLine = ReadLine(ns);
                if (reqLine == null) return;
                string[] parts = reqLine.Split(' ');
                if (parts.Length < 2) return;
                string method = parts[0].ToUpperInvariant();
                string rawTarget = parts[1];

                int contentLength = 0;
                string h;
                while ((h = ReadLine(ns)) != null && h.Length > 0)
                {
                    int idx = h.IndexOf(':');
                    if (idx > 0 && h.Substring(0, idx).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                    {
                        int v;
                        if (int.TryParse(h.Substring(idx + 1).Trim(), out v)) contentLength = v;
                    }
                }
                byte[] body = new byte[0];
                if (contentLength > 0 && contentLength < 64 * 1024 * 1024)
                {
                    body = new byte[contentLength];
                    int got = 0;
                    while (got < contentLength)
                    {
                        int n = ns.Read(body, got, contentLength - got);
                        if (n <= 0) break;
                        got += n;
                    }
                }
                Route(ns, method, rawTarget, body);
            }
        }
        catch { }
    }

    static string ReadLine(Stream s)
    {
        StringBuilder sb = new StringBuilder();
        int b = -1;
        while ((b = s.ReadByte()) >= 0)
        {
            if (b == 10) break;
            if (b != 13) sb.Append((char)b);
        }
        if (b < 0 && sb.Length == 0) return null;
        return sb.ToString();
    }

    static void Route(NetworkStream ns, string method, string rawTarget, byte[] body)
    {
        string path = rawTarget;
        string query = "";
        int qi = rawTarget.IndexOf('?');
        if (qi >= 0) { path = rawTarget.Substring(0, qi); query = rawTarget.Substring(qi + 1); }

        if (path == "/api/list") { SendJson(ns, ApiList()); return; }
        if (path == "/api/read") { ApiRead(ns, Q(query, "c"), Q(query, "f")); return; }
        if (path == "/api/upload" && method == "POST") { ApiUpload(ns, Q(query, "c"), Q(query, "f"), body); return; }
        if (path == "/api/mkdir" && method == "POST") { ApiMkdir(ns, Q(query, "c")); return; }
        if (path == "/api/setdir" && method == "POST") { ApiSetDir(ns, Q(query, "d")); return; }
        if (path == "/api/pickdir" && method == "POST") { ApiPickDir(ns); return; }
        if (path == "/api/state" && method == "GET") { ApiGetState(ns); return; }
        if (path == "/api/state" && method == "POST") { ApiPutState(ns, body); return; }
        if (path == "/api/alive")
        {
            if (Token.Length > 0 && Q(query, "t") == Token)
            {
                SeenPing = true;
                LastPing = DateTime.Now;
                Bye = false;        // 还有页面在跳动 → 撤销刚收到的告别信号
            }
            SendText(ns, 200, "text/plain; charset=utf-8", "ok"); return;
        }
        if (path == "/api/bye")
        {
            // 令牌对不上 = 上一次会话的残留页面，忽略（否则会把当前服务误杀）
            if (Token.Length > 0 && Q(query, "t") == Token) Bye = true;
            SendText(ns, 200, "text/plain; charset=utf-8", "bye"); return;
        }
        if (path == "/api/ping") { SendText(ns, 200, "text/plain; charset=utf-8", "ok"); return; }
        SendStatic(ns, Uri.UnescapeDataString(path));
    }

    static string Q(string query, string key)
    {
        foreach (string pair in query.Split('&'))
        {
            int eq = pair.IndexOf('=');
            if (eq > 0 && pair.Substring(0, eq) == key) return Uri.UnescapeDataString(pair.Substring(eq + 1).Replace("+", " "));
        }
        return "";
    }

    // ---------- API ----------

    // 只保留文件名 / 文件夹名，并剔掉 Windows 不允许的字符（挡路径穿越 + 挡非法名）
    static string SafeName(string s)
    {
        if (s == null) return "";
        string t = Path.GetFileName(s);
        char[] bad = Path.GetInvalidFileNameChars();
        StringBuilder sb = new StringBuilder();
        foreach (char ch in t)
        {
            bool ok = true;
            foreach (char b in bad) if (ch == b) { ok = false; break; }
            if (ok) sb.Append(ch);
        }
        return sb.ToString().Trim().Trim('.');
    }

    static string SafeJoin(string course, string file)
    {
        string dir = BankDir;
        string c = SafeName(course);
        if (c.Length > 0) dir = Path.Combine(BankDir, c);
        return Path.Combine(dir, SafeName(file));
    }

    static readonly string[] BANK_EXTS = new string[] { ".txt", ".docx", ".md", ".text" };

    static bool IsBankFile(string f)
    {
        string e = Path.GetExtension(f).ToLowerInvariant();
        foreach (string x in BANK_EXTS) if (x == e) return true;
        return false;
    }

    // 课程 = 题库文件夹下的一级子文件夹；根目录下的散装文件归入「未分类」
    static string ApiList()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"dir\":").Append(JsonStr(BankDir))
          .Append(",\"defdir\":").Append(JsonStr(Path.Combine(BaseDir, "题库")))
          .Append(",\"courses\":[");
        bool firstCourse = true;
        try
        {
            List<string> rootFiles = new List<string>();
            foreach (string f in Directory.GetFiles(BankDir))
                if (IsBankFile(f)) rootFiles.Add(f);
            if (rootFiles.Count > 0)
            {
                sb.Append("{\"key\":\"\",\"name\":\"未分类\",\"papers\":").Append(PaperArray(rootFiles)).Append('}');
                firstCourse = false;
            }

            List<string> dirs = new List<string>();
            foreach (string d in Directory.GetDirectories(BankDir)) dirs.Add(d);
            dirs.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string d in dirs)
            {
                List<string> fs = new List<string>();
                foreach (string f in Directory.GetFiles(d)) if (IsBankFile(f)) fs.Add(f);
                if (!firstCourse) sb.Append(',');
                firstCourse = false;
                string nm = Path.GetFileName(d);
                sb.Append("{\"key\":").Append(JsonStr(nm))
                  .Append(",\"name\":").Append(JsonStr(nm))
                  .Append(",\"papers\":").Append(PaperArray(fs)).Append('}');
            }
        }
        catch { }
        sb.Append("]}");
        return sb.ToString();
    }

    static string PaperArray(List<string> files)
    {
        files.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < files.Count; i++)
        {
            if (i > 0) sb.Append(',');
            FileInfo fi = new FileInfo(files[i]);
            sb.Append("{\"name\":").Append(JsonStr(fi.Name))
              .Append(",\"size\":").Append(fi.Length)
              .Append(",\"mtime\":").Append(JsonStr(fi.LastWriteTime.ToString("yyyy-MM-dd HH:mm")))
              .Append(",\"ticks\":").Append(JsonStr(fi.LastWriteTime.Ticks.ToString()))
              .Append('}');
        }
        return sb.Append(']').ToString();
    }

    static void ApiRead(NetworkStream ns, string course, string name)
    {
        if (name.Length == 0) { SendText(ns, 400, "text/plain; charset=utf-8", "缺少 f 参数"); return; }
        string full = SafeJoin(course, name);
        if (!File.Exists(full)) { SendText(ns, 404, "text/plain; charset=utf-8", "文件不存在: " + name); return; }
        SendBytes(ns, 200, "application/octet-stream", File.ReadAllBytes(full));
    }

    static void ApiUpload(NetworkStream ns, string course, string name, byte[] body)
    {
        try
        {
            string fn = SafeName(name);
            if (fn.Length == 0) { SendText(ns, 400, "text/plain; charset=utf-8", "文件名不能为空"); return; }
            string c = SafeName(course);
            string dir = c.Length == 0 ? BankDir : Path.Combine(BankDir, c);
            Directory.CreateDirectory(dir);
            string full = Path.Combine(dir, fn);
            File.WriteAllBytes(full, body);
            Log("导入文件: " + full + " (" + body.Length + " 字节)");
            SendText(ns, 200, "application/json; charset=utf-8", "{\"ok\":true,\"course\":" + JsonStr(c) + ",\"name\":" + JsonStr(fn) + "}");
        }
        catch (Exception ex) { SendText(ns, 500, "text/plain; charset=utf-8", ex.Message); }
    }

    static void ApiMkdir(NetworkStream ns, string course)
    {
        try
        {
            string c = SafeName(course);
            if (c.Length == 0) { SendText(ns, 400, "text/plain; charset=utf-8", "课程名不能为空"); return; }
            Directory.CreateDirectory(Path.Combine(BankDir, c));
            Log("新建课程: " + c);
            SendText(ns, 200, "application/json; charset=utf-8", "{\"ok\":true,\"course\":" + JsonStr(c) + "}");
        }
        catch (Exception ex) { SendText(ns, 500, "text/plain; charset=utf-8", ex.Message); }
    }

    // ---------- 题库根目录可配置 ----------
    // 存成一个纯文本文件（比塞 JSON 里少踩坑），内容就是一行路径。
    // 默认 = <程序目录>\题库；用户可以在「设置」里指向任意文件夹（例如学习助手的输出目录）。

    static string DirFile() { return Path.Combine(StateDir, "题库目录.txt"); }

    static void LoadConfig()
    {
        BankDir = Path.Combine(BaseDir, "题库");
        try
        {
            if (File.Exists(DirFile()))
            {
                string p = File.ReadAllText(DirFile(), Encoding.UTF8).Trim().Trim('"');
                if (p.Length > 2 && Directory.Exists(p)) BankDir = p;
                else Log("配置里的题库目录不可用，回退默认: " + p);
            }
        }
        catch { }
    }

    static void SaveConfig(string dir)
    {
        try { File.WriteAllText(DirFile(), dir, Encoding.UTF8); } catch { }
    }

    static void ApiSetDir(NetworkStream ns, string d)
    {
        try
        {
            d = (d == null ? "" : d).Trim().Trim('"');
            if (d.Length < 3 || !Directory.Exists(d))
            {
                SendText(ns, 400, "application/json; charset=utf-8", "{\"ok\":false,\"err\":\"这个目录不存在\"}");
                return;
            }
            BankDir = d;
            SaveConfig(d);
            Log("题库根目录改为: " + d);
            SendJson(ns, "{\"ok\":true,\"dir\":" + JsonStr(d) + "}");
        }
        catch (Exception ex) { SendText(ns, 500, "text/plain; charset=utf-8", ex.Message); }
    }

    // 弹一个原生的「选择文件夹」对话框（浏览器拿不到真实路径，只能由程序本体来弹）
    static void ApiPickDir(NetworkStream ns)
    {
        string picked = "";
        try
        {
            Thread t = new Thread(delegate ()
            {
                try
                {
                    using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                    {
                        fbd.Description = "选择题库根目录（里面每个子文件夹 = 一门课；直接放根下的文件归「未分类」）";
                        fbd.SelectedPath = BankDir;
                        fbd.ShowNewFolderButton = false;
                        if (fbd.ShowDialog() == DialogResult.OK) picked = fbd.SelectedPath;
                    }
                }
                catch (Exception ex) { Log("选择文件夹失败: " + ex.Message); }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
        }
        catch (Exception ex) { Log("弹窗线程失败: " + ex.Message); }
        SendJson(ns, "{\"ok\":" + (picked.Length > 0 ? "true" : "false") + ",\"dir\":" + JsonStr(picked) + "}");
    }

    static string StateFile() { return Path.Combine(StateDir, "state.json"); }

    static void ApiGetState(NetworkStream ns)
    {
        try
        {
            if (File.Exists(StateFile())) SendBytes(ns, 200, "application/json; charset=utf-8", File.ReadAllBytes(StateFile()));
            else SendText(ns, 200, "application/json; charset=utf-8", "{}");
        }
        catch (Exception ex) { SendText(ns, 500, "text/plain; charset=utf-8", ex.Message); }
    }

    static void ApiPutState(NetworkStream ns, byte[] body)
    {
        try
        {
            File.WriteAllBytes(StateFile(), body);
            try
            {
                string bak = Path.Combine(StateDir, "state." + DateTime.Now.ToString("yyyyMMdd") + ".bak.json");
                if (!File.Exists(bak)) File.WriteAllBytes(bak, body);
            }
            catch { }
            SendText(ns, 200, "application/json; charset=utf-8", "{\"ok\":true}");
        }
        catch (Exception ex) { SendText(ns, 500, "text/plain; charset=utf-8", ex.Message); }
    }

    // ---------- 静态文件 ----------

    static void SendStatic(NetworkStream ns, string path)
    {
        if (path == "/" || path.Length == 0) path = "/index.html";
        string rel = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        string full;
        try { full = Path.GetFullPath(Path.Combine(AppDir, rel)); }
        catch { SendText(ns, 400, "text/plain; charset=utf-8", "路径非法"); return; }

        if (!full.StartsWith(AppDir, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            SendText(ns, 404, "text/plain; charset=utf-8", "404 " + path);
            return;
        }
        SendBytes(ns, 200, MimeOf(full), File.ReadAllBytes(full));
    }

    static string MimeOf(string f)
    {
        switch (Path.GetExtension(f).ToLowerInvariant())
        {
            case ".html": return "text/html; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".js": return "application/javascript; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".svg": return "image/svg+xml";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".ico": return "image/x-icon";
            case ".woff2": return "font/woff2";
            default: return "application/octet-stream";
        }
    }

    // ---------- 响应 ----------

    static void SendJson(NetworkStream ns, string s) { SendText(ns, 200, "application/json; charset=utf-8", s); }

    static void SendText(NetworkStream ns, int code, string mime, string s)
    {
        SendBytes(ns, code, mime, Encoding.UTF8.GetBytes(s));
    }

    static void SendBytes(NetworkStream ns, int code, string mime, byte[] data)
    {
        string status;
        switch (code)
        {
            case 200: status = "OK"; break;
            case 400: status = "Bad Request"; break;
            case 404: status = "Not Found"; break;
            case 500: status = "Internal Server Error"; break;
            default: status = "OK"; break;
        }
        StringBuilder head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(code).Append(' ').Append(status).Append("\r\n");
        head.Append("Content-Type: ").Append(mime).Append("\r\n");
        head.Append("Content-Length: ").Append(data.Length).Append("\r\n");
        head.Append("Cache-Control: no-store\r\n");
        head.Append("Connection: close\r\n\r\n");
        byte[] hb = Encoding.ASCII.GetBytes(head.ToString());
        ns.Write(hb, 0, hb.Length);
        if (data.Length > 0) ns.Write(data, 0, data.Length);
        ns.Flush();
    }

    static string JsonStr(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 32) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
