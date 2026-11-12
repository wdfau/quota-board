import { BrowserWindow, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constrainPosition } from "../core/floating.js";

const directory = dirname(fileURLToPath(import.meta.url));
const ballSize = { width: 104, height: 104 };
const panelSize = { width: 384, height: 480 };

export class FloatingWindows {
  constructor({ preferences, demo, savePosition }) {
    this.savePosition = savePosition;
    this.ball = this.createSurface(ballSize, "floating-ball.html", demo);
    this.panel = this.createSurface(panelSize, "floating-panel.html", demo);
    const area = screen.getPrimaryDisplay().workArea;
    const saved = preferences.floatingPosition;
    const initial =
      saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? saved
        : { x: area.x + area.width - 128, y: area.y + area.height / 2 - 52 };
    const position = constrainPosition(
      initial,
      screen.getDisplayNearestPoint(initial).workArea,
      ballSize,
    );
    this.ball.setPosition(position.x, position.y);
    this.ball.once("ready-to-show", () => this.ball.showInactive());
    this.panel.on("blur", () => this.panel.hide());
    screen.on("display-removed", () => this.keepVisible());
    screen.on("display-metrics-changed", () => this.keepVisible());
  }

  createSurface(size, file, demo) {
    const window = new BrowserWindow({
      ...size,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: join(directory, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.loadFile(join(directory, file), {
      query: { demo: demo ? "1" : "0" },
    });
    if (process.platform === "win32" && file === "floating-ball.html") {
      const shape = [];
      for (let y = 8; y < 96; y++) {
        const half = Math.sqrt(Math.max(0, 44 * 44 - (y - 52) ** 2));
        if (half < 1) continue;
        shape.push({
          x: Math.floor(52 - half),
          y,
          width: Math.ceil(half * 2),
          height: 1,
        });
      }
      window.setShape(shape);
    }
    return window;
  }

  togglePanel() {
    if (this.panel.isVisible()) return this.panel.hide();
    const ball = this.ball.getBounds();
    const area = screen.getDisplayMatching(ball).workArea;
    const size = {
      ...panelSize,
      height: Math.min(panelSize.height, area.height - 24),
    };
    const point = constrainPosition(
      {
        x:
          ball.x - size.width - 6 >= area.x
            ? ball.x - size.width - 6
            : ball.x + ball.width + 6,
        y: ball.y - 12,
      },
      area,
      size,
    );
    this.panel.setBounds({ ...point, ...size });
    this.panel.show();
    this.panel.focus();
  }

  drag(phase, point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
      return;
    if (phase === "start") {
      this.dragOrigin = { pointer: point, bounds: this.ball.getBounds() };
    } else if (phase === "move" && this.dragOrigin) {
      this.panel.hide();
      const origin = this.dragOrigin;
      const position = constrainPosition(
        {
          x: origin.bounds.x + point.x - origin.pointer.x,
          y: origin.bounds.y + point.y - origin.pointer.y,
        },
        screen.getDisplayNearestPoint(point).workArea,
        ballSize,
      );
      this.ball.setPosition(position.x, position.y);
    } else if (phase === "end" && this.dragOrigin) {
      this.dragOrigin = null;
      const { x, y } = this.ball.getBounds();
      return this.savePosition({ x, y });
    }
  }

  keepVisible() {
    const bounds = this.ball.getBounds();
    const position = constrainPosition(
      bounds,
      screen.getDisplayMatching(bounds).workArea,
      ballSize,
    );
    this.ball.setPosition(position.x, position.y);
    this.panel.hide();
  }
}
