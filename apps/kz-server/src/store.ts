/** Basit kalıcılık (demo): durum JSON dosyasında tutulur, değişiklikten 200 ms sonra yazılır. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T extends object> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(private path: string, init: () => T) {
    if (existsSync(path)) {
      try { this.data = { ...init(), ...JSON.parse(readFileSync(path, "utf8")) }; } catch { this.data = init(); }
    } else this.data = init();
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.data, null, 1)); } catch (e) { console.warn("kayıt yazılamadı", (e as Error).message); }
    }, 200);
  }
}
