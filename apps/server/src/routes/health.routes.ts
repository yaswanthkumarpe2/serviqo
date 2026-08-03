import { Router } from "express";
import mongoose from "mongoose";

import { success } from "../lib/response";

export const healthRouter = Router();

/**
 * Plain liveness check — deliberately not gated on database connectivity
 * (a Mongo blip shouldn't flap the whole process's health status).
 * Database state is reported as information, not as the response code.
 */
healthRouter.get("/health", (_req, res) => {
  success(res, {
    status: "ok",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    uptimeSeconds: Math.round(process.uptime()),
  });
});
