export function registerSyncRoutes(app, ctx) {
  const handlers = createSyncHandlers(ctx);
  app.get("/api/sync/status", handlers.getSyncStatus);
  app.post("/api/sync/settings", handlers.postSyncSettings);
  app.post("/api/sync/sign-in", handlers.postSyncSignIn);
  app.post("/api/sync/sign-out", handlers.postSyncSignOut);
  app.post("/api/sync/push", handlers.postSyncPush);
  app.post("/api/sync/pull", handlers.postSyncPull);
  app.post("/api/sync/run", handlers.postSyncRun);
  app.post("/api/sync/cleanup-deleted", handlers.postSyncCleanupDeleted);
}

function createSyncHandlers(ctx) {
  const { services, persistence, helpers } = ctx;
  const { syncService } = services;
  const { saveSettingsState } = persistence;
  const { syncDiagnostics, normalizeSyncSettings } = helpers;

  async function persistSyncError(error) {
    const state = ctx.getState();
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveSettingsState(["sync"]);
  }

  return {
    getSyncStatus(req, res) {
      res.json({ ...syncService.status(), diagnostics: syncDiagnostics() });
    },

    async postSyncSettings(req, res, next) {
      try {
        res.json(await syncService.updateSettings(req.body ?? {}));
      } catch (error) {
        next(error);
      }
    },

    async postSyncSignIn(req, res, next) {
      try {
        res.json(await syncService.signIn(req.body ?? {}));
      } catch (error) {
        await persistSyncError(error);
        next(error);
      }
    },

    async postSyncSignOut(req, res, next) {
      try {
        res.json(await syncService.signOut());
      } catch (error) {
        next(error);
      }
    },

    async postSyncPush(req, res, next) {
      try {
        res.json(await syncService.push());
      } catch (error) {
        await persistSyncError(error);
        next(error);
      }
    },

    async postSyncPull(req, res, next) {
      try {
        res.json(await syncService.pull());
      } catch (error) {
        await persistSyncError(error);
        next(error);
      }
    },

    async postSyncRun(req, res, next) {
      try {
        res.json(await syncService.syncNow());
      } catch (error) {
        await persistSyncError(error);
        next(error);
      }
    },

    async postSyncCleanupDeleted(req, res, next) {
      try {
        res.json(await syncService.cleanupDeletedRemoteItems());
      } catch (error) {
        await persistSyncError(error);
        next(error);
      }
    }
  };
}
