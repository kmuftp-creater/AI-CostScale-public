// 第四輪：桌面本身建得起來，但上面跑任何載入 user32 的程式都 STATUS_DLL_INIT_FAILED
//（notepad 也一樣，所以不是 agy 的問題）。
// 最後一個值得試的假設：桌面的 heap 是「第一個執行緒接上去」時才配置的，
// 沒有任何執行緒附著的桌面，別的行程接上去就初始化失敗。
// 這一輪在啟動受測程式之前，先讓本行程的一條執行緒 SetThreadDesktop 上去。

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopTry4
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

    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint GENERIC_ALL = 0x10000000;
    private const uint STILL_ACTIVE = 259;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(string name, string dev, IntPtr dm, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    private static void Probe(string label, string lpDesktop, string cmdline)
    {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = lpDesktop;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
                false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi))
        {
            Console.WriteLine(label + " -> CreateProcess 失敗 Win32 " + Marshal.GetLastWin32Error());
            return;
        }
        Thread.Sleep(3000);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        if (code == STILL_ACTIVE)
        {
            Console.WriteLine(label + " -> 3 秒後仍在執行【可用】pid=" + pi.dwProcessId);
            TerminateProcess(pi.hProcess, 0);
        }
        else
        {
            Console.WriteLine(label + " -> 退出碼 0x" + code.ToString("X8") + "【不可用】");
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    public static int Main(string[] args)
    {
        string cmdline = args.Length > 0 ? args[0] : "notepad.exe";
        Console.WriteLine("受測命令列：" + cmdline);
        Console.WriteLine();

        IntPtr hDesk = CreateDesktopW("cs-hidden-t4", null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (hDesk == IntPtr.Zero)
        {
            Console.WriteLine("建立桌面失敗 Win32 " + Marshal.GetLastWin32Error());
            return 1;
        }

        bool attached = false;
        ManualResetEvent ready = new ManualResetEvent(false);
        Thread holder = new Thread(() =>
        {
            attached = SetThreadDesktop(hDesk);
            if (!attached)
                Console.WriteLine("SetThreadDesktop 失敗 Win32 " + Marshal.GetLastWin32Error());
            ready.Set();
            Thread.Sleep(60000);   // 抓著不放，桌面才不會在受測期間被收掉
        });
        holder.IsBackground = true;
        holder.Start();
        ready.WaitOne(5000);
        Console.WriteLine("有執行緒附著到隱藏桌面：" + attached);
        Console.WriteLine();

        Probe("有執行緒附著後啟動    ", "cs-hidden-t4", cmdline);
        CloseDesktop(hDesk);
        return 0;
    }
}
