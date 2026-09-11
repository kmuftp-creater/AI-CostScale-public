// 驗收用的假 agy：起一個「自己開主控台視窗」的子行程，模擬 agy --bg-updater。
//
// 為什麼不能用 `cmd /c start`：start 走的是 ShellExecute，在非互動的桌面上
// 根本啟動不起來（2026-09-01 實測，孫行程沒跑，檔案沒產生）。那樣測出來的
// 「零視窗」是假的——不是視窗被藏起來，是工作根本沒做。
// 這支改用 CreateProcess + CREATE_NEW_CONSOLE，那才是一般程式開窗的路徑。
//
// 用法：ConsoleSpawner.exe <要跑的命令列>
// 例：  ConsoleSpawner.exe "ping -n 4 127.0.0.1"

using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ConsoleSpawner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    private const uint CREATE_NEW_CONSOLE = 0x00000010;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr h, uint ms);

    public static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("需要命令列"); return 64; }
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder(args[0]);
        bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_CONSOLE, IntPtr.Zero, null, ref si, out pi);
        if (!ok)
        {
            Console.Out.WriteLine("SPAWN-FAIL " + Marshal.GetLastWin32Error());
            return 1;
        }
        Console.Out.WriteLine("SPAWN-OK pid=" + pi.dwProcessId);
        WaitForSingleObject(pi.hProcess, 15000);
        return 0;
    }
}
