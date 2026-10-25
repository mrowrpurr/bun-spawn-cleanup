/**
 * Windows escape scenarios. See test/windows-job.test.ts and test/windows-escapes.test.ts
 * for which are expected to be contained, refused, or to escape.
 */
import { dirname, join } from "node:path";
import { q, type ScenarioMap } from "./types.ts";

export const windows: ScenarioMap = {
  // cmd.exe `start /b`: a classic daemonizing idiom. The leaf is a grandchild via cmd, and
  // cmd exits immediately, so the leaf is reparented before anyone looks at it. Written to a
  // .cmd file so Bun's argument quoting cannot interfere.
  async "cmd-start"({ bun, leaf, pidfile }) {
    const script = join(dirname(pidfile), "launch.cmd");
    await Bun.write(script, `@echo off\r\nstart "" /b ${q(bun)} ${q(leaf)} ${q(pidfile)}\r\n`);
    Bun.spawn(["cmd.exe", "/d", "/c", script], { stdio: ["ignore", "ignore", "ignore"] });
    return "leaf-expected";
  },

  // PowerShell Start-Process (ShellExecuteEx under the hood), from a .ps1 file.
  async "ps-start-process"({ bun, leaf, pidfile }) {
    const script = join(dirname(pidfile), "launch.ps1");
    await Bun.write(
      script,
      `Start-Process -FilePath '${bun}' -ArgumentList @('"${leaf}"', '"${pidfile}"') -WindowStyle Hidden\n`,
    );
    Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "leaf-expected";
  },

  // WMI Win32_Process.Create: the process is created by the WMI provider host (WmiPrvSE.exe),
  // which is NOT in our job. This is a known escape. Prints `WMI <ReturnValue> <pid>`.
  async wmi({ bun, leaf, pidfile, say }) {
    const cmdline = `${q(bun)} ${q(leaf)} ${q(pidfile)}`;
    const script =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}' }; ` +
      `Write-Output ("WMI " + $r.ReturnValue + " " + $r.ProcessId)`;
    const p = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    say((await new Response(p.stdout).text()).trim());
    return "leaf-expected";
  },

  // Raw CreateProcessW with CREATE_BREAKAWAY_FROM_JOB. Our job sets no breakaway permission,
  // so the kernel must refuse with ERROR_ACCESS_DENIED (5). Prints `BREAKAWAY {ok,err,pid?}`.
  async breakaway({ bun, leaf, pidfile, say }) {
    const r = createProcessBreakaway(`${q(bun)} ${q(leaf)} ${q(pidfile)}`);
    say(`BREAKAWAY ${JSON.stringify(r)}`);
    return r.ok ? "leaf-expected" : "no-leaf";
  },
};

interface BreakawayResult {
  ok: boolean;
  err: number;
  pid?: number;
}

function createProcessBreakaway(commandLine: string): BreakawayResult {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr, // lpApplicationName
        FFIType.ptr, // lpCommandLine (mutable)
        FFIType.ptr, // lpProcessAttributes
        FFIType.ptr, // lpThreadAttributes
        FFIType.i32, // bInheritHandles
        FFIType.u32, // dwCreationFlags
        FFIType.ptr, // lpEnvironment
        FFIType.ptr, // lpCurrentDirectory
        FFIType.ptr, // lpStartupInfo
        FFIType.ptr, // lpProcessInformation
      ],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
  const CREATE_NO_WINDOW = 0x0800_0000;

  const cmd = new Uint16Array(commandLine.length + 1);
  for (let i = 0; i < commandLine.length; i++) cmd[i] = commandLine.charCodeAt(i);

  const si = new Uint8Array(104); // STARTUPINFOW on x64
  new DataView(si.buffer).setUint32(0, 104, true); // cb
  const pi = new Uint8Array(24); // PROCESS_INFORMATION on x64

  const ok =
    k32.symbols.CreateProcessW(
      null,
      ptr(cmd),
      null,
      null,
      0,
      CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
      null,
      null,
      ptr(si),
      ptr(pi),
    ) !== 0;
  if (!ok) return { ok: false, err: k32.symbols.GetLastError() };
  const dv = new DataView(pi.buffer);
  const pid = dv.getUint32(16, true);
  k32.symbols.CloseHandle(dv.getBigUint64(0, true));
  k32.symbols.CloseHandle(dv.getBigUint64(8, true));
  return { ok: true, err: 0, pid };
}
