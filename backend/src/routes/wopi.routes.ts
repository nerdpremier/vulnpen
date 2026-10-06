import express from "express";
import { Router } from "express";
import { checkWopiFileInfo, getWopiFile, putWopiFile } from "../controllers/web-security.controller";

// WOPI endpoints called by Collabora; authorised by the WOPI access token in
// the query string, not by the app session. Document saves arrive as a raw
// octet-stream body on POST /files/:id/contents.
const router = Router();

router.get("/files/:fileId", checkWopiFileInfo);
router.get("/files/:fileId/contents", getWopiFile);
router.post("/files/:fileId/contents", express.raw({ type: "*/*", limit: "30mb" }), putWopiFile);

export const wopiRoutes = router;
