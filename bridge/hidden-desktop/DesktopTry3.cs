// 第三輪：DACL 也不是答案。改問一個更基本的問題——
// 這台機器上，隱藏桌面到底能不能跑「任何一支會載入 user32 的程式」？
// 用 notepad（純 Win32 GUI，不是 .NET 也不是 Go）當試紙：
// 起得來、活著超過 3 秒，就代表桌面本身是好的，問題在受測程式；
// 一樣秒退，就代表這台機器上這條路整條不通。

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopTry3
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
    private static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    private static void Probe(string label, string lpDesktop, IntPtr hDesk, string cmdline)
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
            Console.WriteLine(label + " -> 3 秒後仍在執行【桌面可用】pid=" + pi.dwProcessId);
            TerminateProcess(pi.hProcess, 0);
        }
        else
        {
            Console.WriteLine(label + " -> 已退出，退出碼 " + (int)code + "【桌面不可用】");
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    public static int Main(string[] args)
    {
        string cmdline = args.Length > 0 ? args[0] : "notepad.exe";
        Console.WriteLine("受測命令列：" + cmdline);
        Console.WriteLine();
        Probe("0 對照：目前桌面        ", null, IntPtr.Zero, cmdline);
        IntPtr hDesk = CreateDesktopW("cs-hidden-probe", null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (hDesk == IntPtr.Zero)
        {
            Console.WriteLine("建立桌面失敗 Win32 " + Marshal.GetLastWin32Error());
            return 1;
        }
        Probe("1 隱藏桌面              ", "cs-hidden-probe", hDesk, cmdline);
        CloseDesktop(hDesk);
        return 0;
    }
}
