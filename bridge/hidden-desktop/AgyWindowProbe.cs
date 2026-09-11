// 閃窗根治法的驗收探針（2026-09-01）。
//
// 隱藏桌面那條路在這台機器上不通（見 doc：任何行程放到新建桌面都
// STATUS_DLL_INIT_FAILED，notepad 也一樣）。這支驗的是另一條路：
//
// 黑窗只在 agy 起 `--bg-updater` 那一輪出現，而 bg-updater 起不起來，
// 由 ~/.gemini/antigravity-cli/last_check.timestamp 的**修改時間**決定。
// 所以在叫 agy 之前把那個時間戳蓋成「現在」，agy 就不會去檢查更新，
// 也就不會有孫行程、不會有窗。呼叫結束後把原本的時間戳還原，
// User 自己互動使用 agy 時該更新照樣更新。
//
// 量法照第八十一節：只認「可見的最上層視窗」且類別是 ConsoleWindowClass。
// 掃行程只能給候選，不能給結論——所以行程與視窗兩邊都記。
//
// 用法：AgyWindowProbe.exe <輪數> <force|guard>
//   force = 每輪把時間戳往回撥三天（強迫更新器出動），當對照組
//   guard = 每輪把時間戳蓋成現在、跑完還原，這是要驗的修法

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AgyWindowProbe
{
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    private delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    private static readonly object Lock = new object();
    private static readonly HashSet<IntPtr> SeenWin = new HashSet<IntPtr>();
    private static readonly HashSet<int> SeenPid = new HashSet<int>();
    private static readonly List<string> Wins = new List<string>();
    private static readonly List<string> Procs = new List<string>();
    private static volatile bool Running = true;

    private static void PollWindows()
    {
        while (Running)
        {
            EnumWindows((h, l) =>
            {
                if (!IsWindowVisible(h)) return true;
                lock (Lock)
                {
                    if (SeenWin.Contains(h)) return true;
                    SeenWin.Add(h);
                    StringBuilder cls = new StringBuilder(128);
                    GetClassName(h, cls, cls.Capacity);
                    if (cls.ToString() != "ConsoleWindowClass") return true;
                    uint pid; GetWindowThreadProcessId(h, out pid);
                    string nm = "?";
                    try { nm = Process.GetProcessById((int)pid).ProcessName; } catch { }
                    Wins.Add(DateTime.Now.ToString("HH:mm:ss.fff") + "  ConsoleWindowClass  " + nm + "(" + pid + ")");
                }
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(50);
        }
    }

    private static void PollProcs()
    {
        while (Running)
        {
            try
            {
                using (ManagementObjectSearcher s = new ManagementObjectSearcher(
                    "SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE Name='agy.exe'"))
                using (ManagementObjectCollection col = s.Get())
                {
                    foreach (ManagementObject mo in col)
                    {
                        int pid = Convert.ToInt32(mo["ProcessId"]);
                        lock (Lock)
                        {
                            if (SeenPid.Contains(pid)) continue;
                            SeenPid.Add(pid);
                            object cl = mo["CommandLine"];
                            Procs.Add(DateTime.Now.ToString("HH:mm:ss.fff") + "  pid=" + pid + "  "
                                + (cl == null ? "(取不到指令列)" : cl.ToString()));
                        }
                    }
                }
            }
            catch { }
            Thread.Sleep(100);
        }
    }

    public static int Main(string[] args)
    {
        int rounds = args.Length > 0 ? int.Parse(args[0]) : 5;
        string mode = args.Length > 1 ? args[1] : "force";
        string agy = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            + "\\agy\\bin\\agy.exe";
        string stamp = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            + "\\.gemini\\antigravity-cli\\last_check.timestamp";

        Console.WriteLine("模式：" + mode + "，輪數：" + rounds);
        Console.WriteLine("時間戳：" + stamp + "（存在：" + File.Exists(stamp) + "）");
        Console.WriteLine();

        Thread w = new Thread(PollWindows); w.IsBackground = true; w.Start();
        Thread p2 = new Thread(PollProcs); p2.IsBackground = true; p2.Start();
        Thread.Sleep(400);
        lock (Lock) { Wins.Clear(); Procs.Clear(); }

        // watch 模式：自己不叫 agy，只純看 N 秒。用來驗「真的橋接跑起來時」
        // 有沒有窗——自己 spawn 的那種只證明得了程式碼，證明不了跑中的服務。
        if (mode == "watch")
        {
            Console.WriteLine("純監看 " + rounds + " 秒……");
            Thread.Sleep(rounds * 1000);
            Running = false;
            w.Join(500); p2.Join(500);
            lock (Lock)
            {
                Console.WriteLine();
                Console.WriteLine("期間的 agy 行程：");
                if (Procs.Count == 0) Console.WriteLine("  （沒有）");
                foreach (string l in Procs) Console.WriteLine("  " + l);
                Console.WriteLine();
                Console.WriteLine("期間新出現的主控台視窗：");
                if (Wins.Count == 0) Console.WriteLine("  （沒有）");
                foreach (string l in Wins) Console.WriteLine("  " + l);
                Console.WriteLine();
                Console.WriteLine("ConsoleWindowClass 視窗數：" + Wins.Count);
                return Wins.Count;
            }
        }

        for (int i = 1; i <= rounds; i++)
        {
            DateTime original = DateTime.MinValue;
            bool haveStamp = File.Exists(stamp);
            if (haveStamp) original = File.GetLastWriteTime(stamp);
            try
            {
                if (haveStamp)
                {
                    if (mode == "force") File.SetLastWriteTime(stamp, DateTime.Now.AddDays(-3));
                    else File.SetLastWriteTime(stamp, DateTime.Now);
                }
            }
            catch (Exception ex) { Console.WriteLine("  時間戳寫入失敗：" + ex.Message); }

            ProcessStartInfo psi = new ProcessStartInfo(agy,
                "--print /usage --output-format json --sandbox");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            DateTime t0 = DateTime.Now;
            Process pr = Process.Start(psi);
            string so = pr.StandardOutput.ReadToEnd();
            string se = pr.StandardError.ReadToEnd();
            pr.WaitForExit();

            if (mode == "guard" && haveStamp)
            {
                // 還原原本的時間戳：User 自己互動用 agy 時，該更新照樣更新。
                try { File.SetLastWriteTime(stamp, original); }
                catch (Exception ex) { Console.WriteLine("  還原時間戳失敗：" + ex.Message); }
            }

            Console.WriteLine("第 " + i + " 輪：" + (DateTime.Now - t0).TotalSeconds.ToString("0.0")
                + " 秒，退出碼 " + pr.ExitCode + "，stdout " + so.Length
                + (so.Contains("remaining_fraction") ? "，含額度資料" : "，**沒有額度資料**")
                + (se.Length > 0 ? "，stderr " + se.Length : ""));
            Thread.Sleep(1800);
        }

        Thread.Sleep(2000);
        Running = false;
        w.Join(500); p2.Join(500);

        int bg = 0;
        Console.WriteLine();
        Console.WriteLine("期間的 agy 行程：");
        lock (Lock)
        {
            foreach (string l in Procs)
            {
                Console.WriteLine("  " + l);
                if (l.Contains("--bg-updater")) bg++;
            }
            Console.WriteLine();
            Console.WriteLine("期間新出現的主控台視窗：");
            if (Wins.Count == 0) Console.WriteLine("  （沒有）");
            foreach (string l in Wins) Console.WriteLine("  " + l);
            Console.WriteLine();
            Console.WriteLine("bg-updater 次數：" + bg + "；ConsoleWindowClass 視窗數：" + Wins.Count);
            return Wins.Count;
        }
    }
}
