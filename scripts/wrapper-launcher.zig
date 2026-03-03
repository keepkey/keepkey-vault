const std = @import("std");

const HANDLE = *anyopaque;
const BOOL = i32;
const DWORD = u32;
const WORD = u16;
const LPWSTR = ?[*:0]u16;

const STARTUPINFOW = extern struct {
    cb: DWORD = @sizeOf(STARTUPINFOW),
    lpReserved: LPWSTR = null,
    lpDesktop: LPWSTR = null,
    lpTitle: LPWSTR = null,
    dwX: DWORD = 0,
    dwY: DWORD = 0,
    dwXSize: DWORD = 0,
    dwYSize: DWORD = 0,
    dwXCountChars: DWORD = 0,
    dwYCountChars: DWORD = 0,
    dwFillAttribute: DWORD = 0,
    dwFlags: DWORD = 0,
    wShowWindow: WORD = 0,
    cbReserved2: WORD = 0,
    lpReserved2: ?*u8 = null,
    hStdInput: ?HANDLE = null,
    hStdOutput: ?HANDLE = null,
    hStdError: ?HANDLE = null,
};

const PROCESS_INFORMATION = extern struct {
    hProcess: ?HANDLE = null,
    hThread: ?HANDLE = null,
    dwProcessId: DWORD = 0,
    dwThreadId: DWORD = 0,
};

extern "kernel32" fn CreateProcessW(
    lpApplicationName: ?[*:0]const u16,
    lpCommandLine: ?[*:0]u16,
    lpProcessAttributes: ?*anyopaque,
    lpThreadAttributes: ?*anyopaque,
    bInheritHandles: BOOL,
    dwCreationFlags: DWORD,
    lpEnvironment: ?*anyopaque,
    lpCurrentDirectory: ?[*:0]const u16,
    lpStartupInfo: *STARTUPINFOW,
    lpProcessInformation: *PROCESS_INFORMATION,
) callconv(.winapi) BOOL;

extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) BOOL;

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var buf: [1024]u8 = undefined;
    const exe_dir = std.fs.selfExeDirPath(&buf) catch return;

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    const launcher_path = try std.fs.path.join(a, &.{ exe_dir, "bin", "launcher.exe" });
    const cmd = try std.fmt.allocPrint(a, "\"{s}\"", .{launcher_path});

    const cmd_w = try std.unicode.utf8ToUtf16LeAllocZ(a, cmd);
    const cwd_w = try std.unicode.utf8ToUtf16LeAllocZ(a, exe_dir);

    var si = STARTUPINFOW{};
    var pi = PROCESS_INFORMATION{};

    // CREATE_NO_WINDOW prevents a console host window from flashing on screen
    // when launching the background bun/launcher process.
    const CREATE_NO_WINDOW: DWORD = 0x08000000;

    const ok = CreateProcessW(
        null,
        cmd_w,
        null,
        null,
        0,
        CREATE_NO_WINDOW,
        null,
        cwd_w,
        &si,
        &pi,
    );

    if (ok != 0) {
        if (pi.hProcess) |h| _ = CloseHandle(h);
        if (pi.hThread) |h| _ = CloseHandle(h);
    }
}
