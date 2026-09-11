// 隱藏桌面包裝的驗收探針（2026-09-01）。
//
// 第八十一節的量測紀律：conhost 出現不等於有視窗，要判斷有沒有閃，
// 只能列舉「可見的最上層視窗」（EnumWindows + IsWindowVisible），
// 看類別是不是 ConsoleWindowClass。掃行程只能給候選，不能給結論。
//
// 用法：DesktopProbe.exe direct  <程式> <參數...>
//       DesktopProbe.exe wrapped <程式> <參數...>
// direct  = 照 Node 現在的做法（CreateProcess + CREATE_NO_WINDOW），當對照組
// wrapped = 走 HiddenDesktopLauncher.exe
//
// 兩邊跑同一個「會開視窗的孫行程」場景，才證明得了差別。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopProbe
{
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    private static readonly object Lock = new object();
    private static readonly HashSet<IntPtr> Seen = new HashSet<IntPtr>();
    private static readonly List<string> Hits = new List<string>();
    private static volatile bool Running = true;

    private static void Snapshot(bool record)
    {
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            lock (Lock)
            {
                if (Seen.Contains(h)) return true;
                Seen.Add(h);
                if (!record) return true;
                StringBuilder cls = new StringBuilder(256);
                GetClassName(h, cls, cls.Capacity);
                StringBuilder title = new StringBuilder(256);
                GetWindowText(h, title, title.Capacity);
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string name = "?";
                try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
                string line = DateTime.Now.ToString("HH:mm:ss.fff") + "  類別=" + cls
                    + "  行程=" + name + "(" + pid + ")  標題=" + title;
                if (cls.ToString() == "ConsoleWindowClass") Hits.Add(line);
                else Hits.Add("(非主控台) " + line);
            }
            return true;
        }, IntPtr.Zero);
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("用法：DesktopProbe.exe <direct|wrapped> <程式> [參數...]");
            return 64;
        }
        string mode = args[0];
        List<string> argv = new List<string>();
        for (int i = 1; i < args.Length; i++) argv.Add(args[i]);

        Snapshot(false);   // 先記下現在就有的視窗，只算之後新出現的
        Thread poller = new Thread(() =>
        {
            while (Running) { Snapshot(true); Thread.Sleep(80); }
        });
        poller.IsBackground = true;
        poller.Start();

        string exeDir = Path.GetDirectoryName(new Uri(
            System.Reflection.Assembly.GetExecutingAssembly().CodeBase).LocalPath);

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;

        string argsFile = null;
        if (mode == "wrapped")
        {
            argsFile = Path.Combine(Path.GetTempPath(),
                "probe-args-" + Guid.NewGuid().ToString("N") + ".bin");
            using (FileStream fs = File.Create(argsFile))
            {
                byte[] sep = new byte[] { 0 };
                for (int i = 0; i < argv.Count; i++)
                {
                    byte[] b = new UTF8Encoding(false).GetBytes(argv[i]);
                    fs.Write(b, 0, b.Length);
                    fs.Write(sep, 0, 1);
                }
            }
            psi.FileName = Path.Combine(exeDir, "HiddenDesktopLauncher.exe");
            psi.Arguments = "\"" + argsFile + "\"";
        }
        else
        {
            psi.FileName = argv[0];
            StringBuilder sb = new StringBuilder();
            for (int i = 1; i < argv.Count; i++)
            {
                if (i > 1) sb.Append(' ');
                sb.Append(argv[i].IndexOf(' ') >= 0 ? "\"" + argv[i] + "\"" : argv[i]);
            }
            psi.Arguments = sb.ToString();
        }

        DateTime t0 = DateTime.Now;
        Process p = Process.Start(psi);
        string outText = p.StandardOutput.ReadToEnd();
        string errText = p.StandardError.ReadToEnd();
        p.WaitForExit();
        Thread.Sleep(500);           // 收尾期間再多看一下
        Running = false;
        poller.Join(1000);

        Console.WriteLine("模式：" + mode);
        Console.WriteLine("耗時：" + (DateTime.Now - t0).TotalSeconds.ToString("0.0") + " 秒，退出碼 " + p.ExitCode);
        Console.WriteLine("stdout 長度 " + outText.Length + "，stderr 長度 " + errText.Length);
        if (outText.Length > 0)
            Console.WriteLine("stdout 前 200 字：" + outText.Substring(0, Math.Min(200, outText.Length)).Replace("\r", "").Replace("\n", " | "));
        if (errText.Length > 0)
            Console.WriteLine("stderr 前 200 字：" + errText.Substring(0, Math.Min(200, errText.Length)).Replace("\r", "").Replace("\n", " | "));

        int consoles = 0;
        Console.WriteLine("期間新出現的可見視窗：");
        lock (Lock)
        {
            if (Hits.Count == 0) Console.WriteLine("  （沒有）");
            foreach (string h in Hits)
            {
                Console.WriteLine("  " + h);
                if (!h.StartsWith("(非主控台)")) consoles++;
            }
        }
        Console.WriteLine("ConsoleWindowClass 數量：" + consoles);
        return consoles;
    }
}
