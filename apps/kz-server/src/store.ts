/** Basit kalıcılık (demo): durum JSON dosyasında tutulur, değişiklikten 200 ms sonra yazılır. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T extends object> {
  data: T;
  /** Son yazma sonucu: sağlık ucu buradan okur (yazılamıyorsa sunucu iş göremez). */
  lastError: string | null = null;
  lastSaveTs: string | null = null;
  readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  constructor(private path: string, init: () => T) {
    this.file = path;
    if (existsSync(path)) {
      try { this.data = { ...init(), ...JSON.parse(readFileSync(path, "utf8")) }; } catch { this.data = init(); }
    } else this.data = init();
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.data, null, 1));
        this.lastError = null;
        this.lastSaveTs = new Date().toISOString();
      } catch (e) {
        this.lastError = (e as Error).message;
        console.warn("kayıt yazılamadı", this.lastError);
      }
    }, 200);
  }
}
