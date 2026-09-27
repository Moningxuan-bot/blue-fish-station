// BlueFishStation.cs - tiny desktop shell for DSH (WinForms + WebView2).
// Compiled with the .NET Framework csc (C# 5): no interpolation, no expression-bodied members.
// Source kept pure ASCII; Chinese UI strings are \u escapes.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class BlueFishStation
{
    static readonly string TITLE = "\u84dd\u8272\u5927\u80a5\u9c7c\u5de5\u4f5c\u7ad9";
    static readonly string LOG = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "station.log");
    static readonly Regex URL_RE = new Regex(@"http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+");

    static Process server;
    static string url;
    static Form form;
    static WebView2 web;
    static bool selftest;
    static int exitCode;

    static void Log(string s)
    {
        try { File.AppendAllText(LOG, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s + Environment.NewLine, Encoding.UTF8); }
        catch { }
    }

    [STAThread]
    static int Main(string[] args)
    {
        selftest = Array.IndexOf(args, "--selftest") >= 0;
        Log("=== station start (selftest=" + selftest + ") ===");

        // --selftest must be able to run while a real window is open, so it skips the guard.
        bool createdNew;
        Mutex mutex = new Mutex(true, "BlueFishStationSingleInstance", out createdNew);
        if (!createdNew && !selftest)
        {
            Log("another instance is already running");
            if (!selftest) MessageBox.Show(TITLE + " \u5df2\u7ecf\u5728\u8fd0\u884c\u3002", TITLE, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        url = FindUrl(args);
        if (url == null) url = StartServer();
        if (url == null)
        {
            Log("FAILED: server never reported an authenticated url");
            if (!selftest)
            {
                MessageBox.Show(
                    "\u65e0\u6cd5\u542f\u52a8 DSH \u670d\u52a1\u3002\n" +
                    "\u8bf7\u786e\u8ba4 dsh \u547d\u4ee4\u53ef\u7528\uff0c\u7136\u540e\u91cd\u8bd5\u3002\n" +
                    "\u8be6\u60c5\u89c1 station.log\u3002",
                    TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            StopServer();
            return 2;
        }
        Log("url: " + url);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        form = new Form();
        form.Text = TITLE;
        form.Width = 1380;
        form.Height = 920;
        form.MinimumSize = new Size(900, 600);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.AutoScaleMode = AutoScaleMode.Dpi;
        form.BackColor = Color.FromArgb(15, 17, 21);
        // Window / taskbar icon. Prefer the PNG: the .ico we ship uses PNG-compressed
        // entries, and .NET's Icon class cannot read those (Icon.ToBitmap throws),
        // while Explorer/Shell can. ExtractAssociatedIcon is only the fallback.
        try
        {
            string png = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app-icon-256.png");
            if (File.Exists(png))
            {
                using (Bitmap bmp = new Bitmap(png))
                {
                    form.Icon = Icon.FromHandle(bmp.GetHicon());
                }
            }
            else
            {
                form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
        }
        catch (Exception ex) { Log("icon: " + ex.Message); }

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        // Keep the browser profile out of the program directory (and out of the repo):
        // by default WebView2 creates <exe>.WebView2 next to the exe (~27 MB of cache).
        try
        {
            CoreWebView2CreationProperties props = new CoreWebView2CreationProperties();
            string override_ = FindArg(args, "--userdata=");
            props.UserDataFolder = override_ != null
                ? override_
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BlueFishStation", "WebView2");
            web.CreationProperties = props;
        }
        catch (Exception ex) { Log("user data folder: " + ex.Message); }
        form.Controls.Add(web);

        web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs e)
        {
            Log("webview2 init success=" + e.IsSuccess + (e.InitializationException == null ? "" : " ex=" + e.InitializationException.Message));
        };
        web.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
        {
            Log("navigation completed success=" + e.IsSuccess);
            if (selftest) SelfTest();
        };
        web.Source = new Uri(url);

        if (selftest)
        {
            form.ShowInTaskbar = false;
            form.Opacity = 0;
            form.WindowState = FormWindowState.Minimized;
        }
        form.FormClosed += delegate(object s, FormClosedEventArgs e) { StopServer(); };

        Application.Run(form);
        Log("=== station exit " + exitCode + " ===");
        return exitCode;
    }

    static string FindArg(string[] args, string prefix)
    {
        foreach (string a in args)
        {
            if (a.StartsWith(prefix)) return a.Substring(prefix.Length);
        }
        return null;
    }

    // --url=http://...  (attach to an already running server, used by --selftest)
    static string FindUrl(string[] args)
    {
        foreach (string a in args)
        {
            if (a.StartsWith("--url=")) return a.Substring(6);
        }
        return null;
    }

    static string StartServer()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c dsh web --port 0 --no-open";
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            server = Process.Start(psi);
            Log("server started pid=" + server.Id);
        }
        catch (Exception ex)
        {
            Log("server start failed: " + ex.Message);
            return null;
        }

        Thread reader = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = server.StandardOutput.ReadLine()) != null)
                {
                    Log("server> " + line);
                    if (url == null)
                    {
                        Match m = URL_RE.Match(line);
                        if (m.Success) url = m.Value;
                    }
                }
            }
            catch (Exception ex) { Log("stdout reader: " + ex.Message); }
        });
        reader.IsBackground = true;
        reader.Start();

        Thread errs = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = server.StandardError.ReadLine()) != null) Log("server! " + line);
            }
            catch { }
        });
        errs.IsBackground = true;
        errs.Start();

        Stopwatch sw = Stopwatch.StartNew();
        while (url == null && sw.ElapsedMilliseconds < 90000)
        {
            bool dead = false;
            try { dead = server.HasExited; } catch { dead = true; }
            if (dead) { Log("server exited before reporting a url"); break; }
            Thread.Sleep(100);
        }
        return url;
    }

    static void StopServer()
    {
        try
        {
            if (server != null && !server.HasExited)
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", "/pid " + server.Id + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                Process.Start(psi).WaitForExit(8000);
                Log("server process tree killed");
            }
        }
        catch (Exception ex) { Log("stop server: " + ex.Message); }
    }

    static void SelfTest()
    {
        Log("dpi: form=" + form.DeviceDpi + " web=" + web.DeviceDpi + " screen=" + Screen.PrimaryScreen.Bounds.Width + "x" + Screen.PrimaryScreen.Bounds.Height);
        string js = "(function(){var s=window.__aurora||{};return 'a='+(!!window.__aurora)+';mark='+document.documentElement.getAttribute('data-aurora')+';efforts='+((s.efforts||[]).length)+';ids='+((s.efforts||[]).map(function(e){return e.id}).join('/'))+';rows='+(s.rows||0)+';radios='+(s.radios||0)+';title='+document.title;})()";
        try
        {
            web.CoreWebView2.ExecuteScriptAsync(js).ContinueWith(delegate(Task<string> t)
            {
                string result = "";
                try { result = t.Result; } catch (Exception ex) { result = "task error: " + ex.Message; }
                Log("selftest result " + result);
                exitCode = (result.IndexOf("a=true") >= 0 && result.IndexOf("mark=on") >= 0) ? 0 : 3;
                try { form.BeginInvoke(new Action(delegate() { form.Close(); })); } catch { }
            }, TaskScheduler.Default);
        }
        catch (Exception ex)
        {
            Log("selftest call failed: " + ex.Message);
            exitCode = 4;
            try { form.Close(); } catch { }
        }
    }
}
