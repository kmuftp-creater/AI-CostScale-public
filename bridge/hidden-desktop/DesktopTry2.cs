// 第二輪：全部六種建法都失敗（連「指名一個不存在的桌面」也是同一個錯），
// 指向同一個解釋——行程拿不到那個桌面的存取權。
// 這一輪在建立桌面之後明寫 DACL，再試一次。

using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopTry2
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
    private const uint READ_CONTROL = 0x00020000;
    private const uint WRITE_DAC = 0x00040000;
    private const int DACL_SECURITY_INFORMATION = 4;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(string name, string dev, IntPtr dm, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetUserObjectSecurity(IntPtr obj, ref int si, IntPtr sd);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr p);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string sddl, uint revision, out IntPtr sd, out uint size);

    private static bool ApplySddl(IntPtr obj, string sddl)
    {
        IntPtr sd; uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size))
        {
            Console.WriteLine("      SDDL 轉換失敗 Win32 " + Marshal.GetLastWin32Error());
            return false;
        }
        try
        {
            int si = DACL_SECURITY_INFORMATION;
            if (!SetUserObjectSecurity(obj, ref si, sd))
            {
                Console.WriteLine("      SetUserObjectSecurity 失敗 Win32 " + Marshal.GetLastWin32Error());
                return false;
            }
            return true;
        }
        finally { LocalFree(sd); }
    }

    private static void Run(string label, string deskName, string lpDesktop, string sddl,
                            bool alsoWinsta, string cmdline)
    {
        IntPtr hDesk = CreateDesktopW(deskName, null, IntPtr.Zero, 0,
            GENERIC_ALL | READ_CONTROL | WRITE_DAC, IntPtr.Zero);
        if (hDesk == IntPtr.Zero)
        {
            Console.WriteLine(label + " -> 建立桌面失敗 Win32 " + Marshal.GetLastWin32Error());
            return;
        }
        if (sddl != null) ApplySddl(hDesk, sddl);
        if (alsoWinsta)
        {
            IntPtr ws = GetProcessWindowStation();
            if (ws != IntPtr.Zero) ApplySddl(ws, sddl);
        }

        STARTUPINFO si2 = new STARTUPINFO();
        si2.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si2.lpDesktop = lpDesktop;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
            false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si2, out pi);
        if (!ok)
        {
            Console.WriteLine(label + " -> CreateProcess 失敗 Win32 " + Marshal.GetLastWin32Error());
            CloseDesktop(hDesk);
            return;
        }
        WaitForSingleObject(pi.hProcess, 20000);
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        Console.WriteLine(label + " -> 退出碼 " + (int)code + (code == 0 ? "  【成功】" : "  【失敗】"));
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseDesktop(hDesk);
    }

    public static int Main(string[] args)
    {
        string cmdline = args.Length > 0 ? args[0] : "cmd.exe /c exit 0";
        Console.WriteLine("受測命令列：" + cmdline);
        Console.WriteLine();
        // WD = Everyone。這台機器是單人用的家用主機，桌面上跑的只有 agy，
        // 放寬到 Everyone 換取「一定打得開」；要收緊可改成當前使用者的 SID。
        string sddl = "D:(A;;GA;;;WD)(A;;GA;;;SY)";
        Run("F 建桌面 ＋ 明寫 DACL（純名稱）        ", "cs-hidden-f", "cs-hidden-f", sddl, false, cmdline);
        Run("G 建桌面 ＋ 明寫 DACL（WinSta0 前綴）  ", "cs-hidden-g", "WinSta0\\cs-hidden-g", sddl, false, cmdline);
        // 刻意不測「順便改 window station 的 DACL」：那會動到整個互動工作階段的
        // 安全性設定，為了不閃黑窗去放寬 WinSta0 是不成比例的代價。
        return 0;
    }
}
