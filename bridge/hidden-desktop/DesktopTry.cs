// 找出「能讓 user32 初始化成功」的隱藏桌面建法（2026-09-01）。
//
// 第一版用 CreateDesktop(name, GENERIC_ALL) ＋ lpDesktop="costscale-hidden"，
// agy 在上面直接 panic：Failed to load user32: DLL initialization routine failed。
// .NET 的測試程式也一樣。所以那個桌面根本不能用，不是 agy 的問題。
//
// 這支把幾種建法各試一次，跑同一個受測程式，印出誰活著。

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopTry
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

    private const int STARTF_USESTDHANDLES = 0x100;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint HANDLE_FLAG_INHERIT = 1;

    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint DESKTOP_CREATEWINDOW = 0x0002;
    private const uint DESKTOP_CREATEMENU = 0x0004;
    private const uint DESKTOP_HOOKCONTROL = 0x0008;
    private const uint DESKTOP_JOURNALRECORD = 0x0010;
    private const uint DESKTOP_JOURNALPLAYBACK = 0x0020;
    private const uint DESKTOP_ENUMERATE = 0x0040;
    private const uint DESKTOP_WRITEOBJECTS = 0x0080;
    private const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    private const uint GENERIC_ALL = 0x10000000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(string name, string dev, IntPtr dm, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    private static void Try(string label, string deskName, uint access, string lpDesktop, string cmdline)
    {
        IntPtr hDesk = IntPtr.Zero;
        if (deskName != null)
        {
            hDesk = CreateDesktopW(deskName, null, IntPtr.Zero, 0, access, IntPtr.Zero);
            if (hDesk == IntPtr.Zero)
            {
                Console.WriteLine(label + " -> 建立桌面失敗 Win32 " + Marshal.GetLastWin32Error());
                return;
            }
        }
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = lpDesktop;
        si.dwFlags = 0;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
            false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi);
        if (!ok)
        {
            Console.WriteLine(label + " -> CreateProcess 失敗 Win32 " + Marshal.GetLastWin32Error());
            if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
            return;
        }
        WaitForSingleObject(pi.hProcess, 20000);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        Console.WriteLine(label + " -> 退出碼 " + (int)code + (code == 0 ? "  【成功】" : "  【失敗】"));
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    }

    public static int Main(string[] args)
    {
        string cmdline = args.Length > 0 ? args[0] : "cmd.exe /c exit 0";
        Console.WriteLine("受測命令列：" + cmdline);
        Console.WriteLine();

        uint full = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU
            | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK
            | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP;

        Try("0 對照：目前桌面（lpDesktop=null）        ", null, 0, null, cmdline);
        Try("A GENERIC_ALL ＋ 純名稱                   ", "cs-hidden-a", GENERIC_ALL, "cs-hidden-a", cmdline);
        Try("B GENERIC_ALL ＋ WinSta0\\ 前綴            ", "cs-hidden-b", GENERIC_ALL, "WinSta0\\cs-hidden-b", cmdline);
        Try("C 逐項 DESKTOP_* ＋ 純名稱                ", "cs-hidden-c", full, "cs-hidden-c", cmdline);
        Try("D 逐項 DESKTOP_* ＋ WinSta0\\ 前綴         ", "cs-hidden-d", full, "WinSta0\\cs-hidden-d", cmdline);
        Try("E 不建桌面，只指名一個不存在的桌面        ", null, 0, "cs-nonexistent", cmdline);
        return 0;
    }
}
