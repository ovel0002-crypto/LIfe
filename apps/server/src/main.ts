import { buildApp, createServices } from "./app";
import { config } from "./config";
import { openDb } from "./db";
import { startJobs } from "./jobs";

const db = await openDb();
const services = createServices(db);
const app = await buildApp(services);
await services.review.ensureEvent();
await services.planner.replan({ reason: "startup" });
if (process.env.LIFE_DISABLE_JOBS !== "1") startJobs(services);
await app.listen({ port: config.port, host: config.host });
