// 在「隱藏桌面」上啟動一支外部程式，讓它與它的子孫行程開的視窗都看不見。
//
// 為什麼要有這支（2026-09-01，第八十一節）：
// 橋接每次叫 agy 查 Antigravity 額度，agy 自己會再起 `agy --bg-updater`、
// 那個又起 `agy --version`，而黑窗是最後那一層開的。Node 的 spawn 帶
// `windowsHide: true` 只約束「父行程給不給子行程視窗」，射程只有一層，
// 管不到孫行程自己 AllocConsole 開的窗。
//
// 唯一能根治的是換一個「桌面」。視窗一定要畫在某個 desktop 上，而行程的
// desktop 由建立時的 STARTUPINFO.lpDesktop 決定，且**子孫行程預設繼承**。
// 所以只要把 agy 放到一個沒有被顯示的 desktop，整棵樹的視窗都不會出現在
// User 眼前——不管它們自己怎麼開窗。
//
// Node 的 spawn 指定不了 lpDesktop，所以要這支包裝。
//
// 用法：
//   HiddenDesktopLauncher.exe <argsfile>
//
// <argsfile> 是 UTF-8、用 NUL (0x00) 分隔的字串清單，第一個是程式、其餘是參數。
// 為什麼不直接用命令列傳：參數裡有 prompt，含引號與換行，
// 「拆成 argv 再組回命令列」來回一趟很容易出錯，那會變成注入面。
// 用檔案傳就完全沒有這個問題。檔案讀完立刻刪除。
//
// 這支**絕對不對 stdout／stderr 寫任何東西**。那兩條是 agy 的輸出通道，
// 橋接會解析；包裝自己插一行進去就會變成解析失敗或假的錯誤訊息。
// 診斷一律寫到 %LOCALAPPDATA%\costscale-bridge\agy-hidden.log。
//
// 失敗時的行為是「照樣把程式跑起來，只是不換桌面」——
// 閃窗是外觀問題，額度查不到是功能問題，不可以為了前者犧牲後者。

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    internal const int STARTF_USESTDHANDLES = 0x00000100;
    internal const uint CREATE_NO_WINDOW = 0x08000000;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    internal const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    internal const int STD_INPUT_HANDLE = -10;
    internal const int STD_OUTPUT_HANDLE = -11;
    internal const int STD_ERROR_HANDLE = -12;
    internal const uint GENERIC_ALL = 0x10000000;
    internal const uint INFINITE = 0xFFFFFFFF;
    internal const uint HANDLE_FLAG_INHERIT = 0x00000001;

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateDesktopW(
        string lpszDesktop, string lpszDevice, IntPtr pDevmode,
        uint dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetInformationJobObject(
        IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
}

public static class HiddenDesktopLauncher
{
    // 桌面名稱固定。同名的 desktop 已存在時 CreateDesktop 直接回既有的那個，
    // 所以不需要自己管生命週期：最後一個行程結束、handle 全關掉，系統自己收。
    private const string DesktopName = "costscale-hidden";

    private static string _logPath;

    private static void Log(string msg)
    {
        try
        {
            if (_logPath == null) return;
            File.AppendAllText(_logPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
    }

    private static void InitLog()
    {
        try
        {
            string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(root)) root = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(root)) return;
            string dir = Path.Combine(root, "costscale-bridge");
            Directory.CreateDirectory(dir);
            string p = Path.Combine(dir, "agy-hidden.log");
            // 只留最後 500 行，這支一天最多被叫幾十次，不需要輪替機制。
            if (File.Exists(p) && new FileInfo(p).Length > 256 * 1024)
            {
                string[] all = File.ReadAllLines(p);
                int keep = Math.Min(500, all.Length);
                string[] tail = new string[keep];
                Array.Copy(all, all.Length - keep, tail, 0, keep);
                File.WriteAllLines(p, tail, new UTF8Encoding(false));
            }
            _logPath = p;
        }
        catch { }
    }

    // Windows 的命令列引用規則（CommandLineToArgvW 的反向）。
    // Node 的 child_process 在 shell:false 時做的也是這一套，兩邊結果一致。
    private static string QuoteArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        for (int i = 0; ; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { i++; slashes++; }
            if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
            if (arg[i] == '"') { sb.Append('\\', slashes * 2 + 1); }
            else { sb.Append('\\', slashes); }
            sb.Append(arg[i]);
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static int Main(string[] rawArgs)
    {
        InitLog();
        if (rawArgs.Length < 1)
        {
            Log("錯誤：沒有給 argsfile");
            return 64;
        }

        List<string> argv = new List<string>();
        try
        {
            byte[] blob = File.ReadAllBytes(rawArgs[0]);
            string all = new UTF8Encoding(false).GetString(blob);
            foreach (string s in all.Split('\0'))
            {
                if (s.Length > 0) argv.Add(s);
            }
            try { File.Delete(rawArgs[0]); } catch { }
        }
        catch (Exception ex)
        {
            Log("錯誤：讀不到 argsfile：" + ex.Message);
            return 65;
        }

        if (argv.Count == 0)
        {
            Log("錯誤：argsfile 是空的");
            return 66;
        }

        StringBuilder cmdline = new StringBuilder();
        for (int i = 0; i < argv.Count; i++)
        {
            if (i > 0) cmdline.Append(' ');
            cmdline.Append(QuoteArg(argv[i]));
        }

        // 桌面。失敗就用 null，代表「沿用目前這個桌面」——退回到原本的行為，
        // 閃窗會回來，但功能不會壞。
        IntPtr hDesktop = Native.CreateDesktopW(
            DesktopName, null, IntPtr.Zero, 0, Native.GENERIC_ALL, IntPtr.Zero);
        string desktop = DesktopName;
        if (hDesktop == IntPtr.Zero)
        {
            Log("警告：建立桌面失敗（Win32 " + Marshal.GetLastWin32Error() + "），改用目前的桌面");
            desktop = null;
        }

        IntPtr hIn = Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        IntPtr hOut = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        IntPtr hErr = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
        foreach (IntPtr h in new[] { hIn, hOut, hErr })
        {
            if (h != IntPtr.Zero && h != new IntPtr(-1))
                Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT);
        }

        Native.STARTUPINFO si = new Native.STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
        si.lpDesktop = desktop;
        si.dwFlags = Native.STARTF_USESTDHANDLES;
        si.hStdInput = hIn;
        si.hStdOutput = hOut;
        si.hStdError = hErr;

        // Job：包裝被殺（橋接逾時會 child.kill()）時，整棵 agy 樹一起收掉。
        // 沒有這個的話孫行程會變孤兒留在隱藏桌面上，看不見也殺不到。
        IntPtr hJob = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (hJob != IntPtr.Zero)
        {
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info =
                new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int len = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                // 9 = JobObjectExtendedLimitInformation
                if (!Native.SetInformationJobObject(hJob, 9, p, (uint)len))
                    Log("警告：設定 job 失敗（Win32 " + Marshal.GetLastWin32Error() + "）");
            }
            finally { Marshal.FreeHGlobal(p); }
        }
        else
        {
            Log("警告：建立 job 失敗（Win32 " + Marshal.GetLastWin32Error() + "）");
        }

        Native.PROCESS_INFORMATION pi;
        bool ok = Native.CreateProcessW(
            null, cmdline, IntPtr.Zero, IntPtr.Zero,
            true, Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT,
            IntPtr.Zero, null, ref si, out pi);

        if (!ok)
        {
            int err = Marshal.GetLastWin32Error();
            Log("錯誤：CreateProcess 失敗（Win32 " + err + "）：" + argv[0]);
            if (hJob != IntPtr.Zero) Native.CloseHandle(hJob);
            if (hDesktop != IntPtr.Zero) Native.CloseDesktop(hDesktop);
            return 67;
        }

        if (hJob != IntPtr.Zero && !Native.AssignProcessToJobObject(hJob, pi.hProcess))
            Log("警告：AssignProcessToJobObject 失敗（Win32 " + Marshal.GetLastWin32Error() + "）");

        Native.WaitForSingleObject(pi.hProcess, Native.INFINITE);
        uint code;
        if (!Native.GetExitCodeProcess(pi.hProcess, out code)) code = 68;

        Native.CloseHandle(pi.hThread);
        Native.CloseHandle(pi.hProcess);
        if (hJob != IntPtr.Zero) Native.CloseHandle(hJob);
        if (hDesktop != IntPtr.Zero) Native.CloseDesktop(hDesktop);
        return (int)code;
    }
}
