const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  formats: ["text/plain"],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.formats = ["text/plain"];
  },
  readHTML() {
    return "";
  },
  readRTF() {
    return "";
  },
  readImage() {
    return { isEmpty: () => true };
  },
  write() {},
  writeImage() {},
};

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");

const originalLoad = Module._load;

// Delegate spawn through a mutable reference so the module is loaded once but
// each test can install its own recorder.
let currentSpawn = childProcess.spawn;

function loadClipboardManager() {
  delete require.cache[clipboardModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: fakeClipboard,
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      };
    }
    if (request === "child_process") {
      return { ...childProcess, spawn: (...args) => currentSpawn(...args) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

const ClipboardManager = loadClipboardManager();

// Each ClipboardManager registers a process "exit" listener; these tests create
// one instance per case, which trips the default max-listeners warning.
process.setMaxListeners(30);

function recordingSpawn(calls, { failFor = () => false } = {}) {
  return (command, args = []) => {
    calls.push({ command, args });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    process.nextTick(() => proc.emit("close", failFor(command) ? 1 : 0));
    return proc;
  };
}

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const LINUX_SESSION_ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
];

async function withLinuxSession(vars, fn) {
  const saved = {};
  for (const key of LINUX_SESSION_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of LINUX_SESSION_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function createLinuxManager({
  fastPasteBinary = null,
  commands = [],
  ydotoolDaemon = false,
  ydotoolLegacy = false,
} = {}) {
  const manager = new ClipboardManager();
  const available = new Set(commands);
  manager.resolveLinuxFastPasteBinary = () => fastPasteBinary;
  manager.commandExists = (cmd) => available.has(cmd);
  manager._isYdotoolDaemonRunning = () => ydotoolDaemon;
  manager._isYdotoolLegacy = () => ydotoolLegacy;
  return manager;
}

test("macOS Enter uses osascript key code 36 (Return)", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = new ClipboardManager();

  await withPlatform("darwin", () => manager._pressEnter());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  assert.deepEqual(calls[0].args, ["-e", 'tell application "System Events" to key code 36']);
});

test("Windows Enter prefers nircmd, falls back to PowerShell SendKeys", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = new ClipboardManager();
  manager.getNircmdPath = () => "C:\\fake\\nircmd.exe";

  await withPlatform("win32", () => manager._pressEnter());
  assert.deepEqual(calls.at(-1), {
    command: "C:\\fake\\nircmd.exe",
    args: ["sendkeypress", "enter"],
  });

  manager.getNircmdPath = () => null;
  await withPlatform("win32", () => manager._pressEnter());
  assert.equal(calls.at(-1).command, "powershell.exe");
  assert.match(calls.at(-1).args.at(-1), /SendWait\('\{ENTER\}'\)/);
});

test("Linux Enter uses the native binary with --press-enter when available", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({ fastPasteBinary: "/opt/linux-fast-paste" });

  await withLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () =>
    manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "/opt/linux-fast-paste", args: ["--press-enter"] });
});

test("Linux Enter falls back to xdotool when the native binary fails on X11", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls, { failFor: (cmd) => cmd === "/opt/linux-fast-paste" });
  const manager = createLinuxManager({
    fastPasteBinary: "/opt/linux-fast-paste",
    commands: ["xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () =>
    manager._pressEnterLinux()
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    ["/opt/linux-fast-paste", "xdotool"]
  );
  assert.deepEqual(calls[1].args, ["key", "Return"]);
});

test("Linux Enter prefers wtype on wlroots Wayland", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["wtype", "xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "sway",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "wtype", args: ["-k", "Return"] });
});

test("Linux Enter prefers ydotool on GNOME Wayland with modern raw keycodes", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "ydotool", args: ["key", "28:1", "28:0"] });
});

test("Linux Enter uses evdev key name for legacy ydotool 0.1.x", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["ydotool"],
    ydotoolDaemon: true,
    ydotoolLegacy: true,
  });

  await withLinuxSession(
    { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "gnome" },
    () => manager._pressEnterLinux()
  );

  assert.deepEqual(calls[0], { command: "ydotool", args: ["key", "enter"] });
});

test("Linux Enter skips ydotool when the client binary is missing despite a daemon socket", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["xdotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    ["xdotool"]
  );
});

test("Linux Enter throws when no tool is available", async () => {
  currentSpawn = recordingSpawn([]);
  const manager = createLinuxManager();

  await withLinuxSession({ XDG_SESSION_TYPE: "x11" }, () =>
    assert.rejects(manager._pressEnterLinux(), /No tool available to send Enter on Linux/)
  );
});

test("pasteText sends Enter after paste only when submitAfterPaste is set", async () => {
  currentSpawn = recordingSpawn([]);
  const events = [];
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => null;
  manager.getNircmdPath = () => null;
  manager.pasteWindows = async () => {
    events.push("paste");
    return { restoreComplete: Promise.resolve() };
  };
  manager._pressEnter = async () => {
    events.push("enter");
  };

  await withPlatform("win32", async () => {
    await manager.pasteText("hello", { restoreClipboard: false });
    assert.deepEqual(events, ["paste"]);

    await manager.pasteText("hello", { restoreClipboard: false, submitAfterPaste: true });
    assert.deepEqual(events, ["paste", "paste", "enter"]);
  });
});

test("pasteText resolves even when sending Enter fails", async () => {
  currentSpawn = recordingSpawn([]);
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => null;
  manager.getNircmdPath = () => null;
  manager.pasteWindows = async () => ({ restoreComplete: Promise.resolve() });
  manager._pressEnter = async () => {
    throw new Error("no tool");
  };

  await withPlatform("win32", () =>
    manager.pasteText("hello", { restoreClipboard: false, submitAfterPaste: true })
  );
});
