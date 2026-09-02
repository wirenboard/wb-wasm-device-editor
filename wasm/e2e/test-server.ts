import type { Server } from 'http';
import path from 'path';
import express from 'express';

export class TestServer {
  private app: express.Application;
  private server: Server | null = null;
  private delayMs = 0;

  constructor(
    private distDir: string,
    private port = 3210,
  ) {
    this.app = express();

    // Configurable delay middleware (server-side throttling)
    this.app.use((_req, _res, next) => {
      if (this.delayMs > 0) {
        setTimeout(next, this.delayMs);
      } else {
        next();
      }
    });

    // No-cache for sw.js so browser always fetches fresh copy on update()
    this.app.use('/sw.js', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });

    // The navigation document must not come from Chrome's HTTP cache, or the
    // SW's fetch() never reaches the deliberately slow network.
    this.app.use((req, res, next) => {
      if (req.path === '/' || !path.extname(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
      }
      next();
    });

    this.app.use(express.static(this.distDir, { maxAge: 0 }));

    // SPA fallback
    this.app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(this.distDir, 'index.html'));
    });
  }

  setDelay(ms: number) {
    this.delayMs = ms;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.closeAllConnections();
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }
}
