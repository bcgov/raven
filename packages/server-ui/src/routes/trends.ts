/**
 * Error trends and version history API.
 *
 * GET /api/trends/errors?app=&component=&server=&days=30
 * GET /api/trends/versions?app=&component=&days=90
 */
import { Router } from "express";
import { getErrorTrends, getVersionHistory } from "../lib/store.js";
import { validateServer, validateAppName } from "../lib/validate.js";

export const trendsRouter = Router();

/** Error snapshots for charting. */
trendsRouter.get("/errors", (req, res) => {
  const app = req.query.app as string | undefined;
  const component = req.query.component as string | undefined;
  const server = req.query.server as string | undefined;
  const days = parseInt((req.query.days as string) || "30", 10);

  if (app && !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }
  if (component && !validateAppName(component)) {
    res.status(400).json({ error: "Invalid component name" });
    return;
  }
  if (server && !validateServer(server)) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }
  if (isNaN(days) || days < 1 || days > 90) {
    res.status(400).json({ error: "days must be between 1 and 90" });
    return;
  }

  const snapshots = getErrorTrends({ app, component, server, days });
  res.json({ snapshots, days });
});

/** Version change history for the deployment timeline. */
trendsRouter.get("/versions", (req, res) => {
  const app = req.query.app as string | undefined;
  const component = req.query.component as string | undefined;
  const days = parseInt((req.query.days as string) || "90", 10);

  if (app && !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }
  if (component && !validateAppName(component)) {
    res.status(400).json({ error: "Invalid component name" });
    return;
  }
  if (isNaN(days) || days < 1 || days > 180) {
    res.status(400).json({ error: "days must be between 1 and 180" });
    return;
  }

  const snapshots = getVersionHistory({ app, component, days });
  res.json({ snapshots, days });
});
