// 量 agy 的背景更新器到底有沒有被叫起來（2026-09-01）。
//
// 第八十一節的結論是「agy --help 沒有關掉背景更新器的選項」，
// 但沒有查環境變數。二進位檔裡有 AGY_CLI_DISABLE_AUTO_UPDATE，
// 位置就在 "failed to check for updates" 旁邊。這支用實跑驗證它有沒有用。
//
// 量法：一邊每 100 毫秒列舉一次 agy.exe 的指令列，一邊反覆跑
// `agy --print /usage`，數出現幾次 --bg-updater。
// 背景更新器不是每次都跑（第八十一節已證），所以要跑很多輪才有意義。
//
// 用法：AgyUpdaterProbe.exe <輪數> <on|off>
//   off = 不設環境變數（現況）
//   on  = 設 AGY_CLI_DISABLE_AUTO_UPDATE=1

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Threading;

public static class AgyUpdaterProbe
{
    private static readonly object Lock = new object();
    private static readonly HashSet<int> SeenPids = new HashSet<int>();
    private static readonly List<string> Tree = new List<string>();
    private static volatile bool Running = true;

    private static void Poll()
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
                            if (SeenPids.Contains(pid)) continue;
                            SeenPids.Add(pid);
                            object ppo = mo["ParentProcessId"];
                            object cl = mo["CommandLine"];
                            string line = DateTime.Now.ToString("HH:mm:ss.fff")
                                + "  pid=" + pid
                                + "  父=" + (ppo == null ? "?" : ppo.ToString())
                                + "  " + (cl == null ? "(取不到指令列)" : cl.ToString());
                            Tree.Add(line);
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
        bool disable = args.Length > 1 && args[1] == "on";
        string agy = Environment.GetEnvironmentVariable("BRIDGE_AGY");
        if (string.IsNullOrEmpty(agy))
            agy = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
                + "\\agy\\bin\\agy.exe";

        Console.WriteLine("agy：" + agy);
        Console.WriteLine("輪數：" + rounds + "，AGY_CLI_DISABLE_AUTO_UPDATE=" + (disable ? "1" : "（不設）"));
        Console.WriteLine();

        Thread poller = new Thread(Poll);
        poller.IsBackground = true;
        poller.Start();
        Thread.Sleep(300);
        lock (Lock) { Tree.Clear(); }   // 先把監看啟動前就在跑的 agy 排除掉

        // 背景更新器不是每次都跑：門檻是 ~/.gemini/antigravity-cli/last_check.timestamp
        // 的修改時間（檔案本身是空的）。不把它往回撥，跑幾十輪也只會在第一輪看到一次，
        // 那樣的「沒看到」證明不了任何事。每輪都往回撥三天，強迫它每次都想更新。
        string stamp = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            + "\\.gemini\\antigravity-cli\\last_check.timestamp";

        for (int i = 1; i <= rounds; i++)
        {
            try
            {
                if (System.IO.File.Exists(stamp))
                    System.IO.File.SetLastWriteTime(stamp, DateTime.Now.AddDays(-3));
                else
                    Console.WriteLine("  （找不到 last_check.timestamp，這一輪沒有強迫更新）");
            }
            catch (Exception ex) { Console.WriteLine("  （撥時間失敗：" + ex.Message + "）"); }

            ProcessStartInfo psi = new ProcessStartInfo(agy,
                "--print /usage --output-format json --sandbox");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            if (disable) psi.EnvironmentVariables["AGY_CLI_DISABLE_AUTO_UPDATE"] = "1";
            DateTime t0 = DateTime.Now;
            Process p = Process.Start(psi);
            string outText = p.StandardOutput.ReadToEnd();
            string errText = p.StandardError.ReadToEnd();
            p.WaitForExit();
            bool okJson = outText.Contains("remaining_fraction") || outText.Contains("buckets");
            Console.WriteLine("第 " + i + " 輪：" + (DateTime.Now - t0).TotalSeconds.ToString("0.0")
                + " 秒，退出碼 " + p.ExitCode + "，stdout " + outText.Length + " 位元組"
                + (okJson ? "，含額度資料" : "，**沒有額度資料**")
                + (errText.Length > 0 ? "，stderr " + errText.Length : ""));
            Thread.Sleep(1500);   // 留一點時間讓孫行程被看到
        }

        Thread.Sleep(2000);
        Running = false;
        poller.Join(1000);

        Console.WriteLine();
        Console.WriteLine("期間看到的 agy 行程：");
        int bg = 0;
        lock (Lock)
        {
            foreach (string l in Tree)
            {
                Console.WriteLine("  " + l);
                if (l.Contains("--bg-updater")) bg++;
            }
        }
        Console.WriteLine();
        Console.WriteLine("--bg-updater 次數：" + bg);
        return bg;
    }
}
