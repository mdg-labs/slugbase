import { createRequestHandler } from "@react-router/express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import compression from "compression";
import express from "express";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerBuild } from "react-router";

export async function mountWebClient(
  app: NestExpressApplication,
  serverBuildPath: string,
): Promise<void> {
  const buildPath = serverBuildPath;
  const buildModule = (await import(
    pathToFileURL(buildPath).href
  )) as ServerBuild;

  const buildDir = dirname(buildPath);
  // publicPath is on ServerBuild directly; fallback to "/" if somehow missing
  const publicPath = buildModule.publicPath ?? "/";
  const assetsBuildDirectory = join(
    buildDir,
    "..",
    "client",
  );

  const httpApp = app.getHttpAdapter().getInstance();

  httpApp.use(compression());
  httpApp.use(
    posix.join(publicPath, "assets"),
    express.static(join(assetsBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  httpApp.use(publicPath, express.static(assetsBuildDirectory));

  httpApp.use(
    createRequestHandler({
      build: buildModule,
      mode: process.env.NODE_ENV,
    }),
  );
}
