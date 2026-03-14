"use strict";

exports.default = async function notarizeIfConfigured(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log("[release] Apple notarization credentials are not configured; skipping notarization.");
    return;
  }

  const { notarize } = require("@electron/notarize");
  await notarize({
    appBundleId: "ai.intelligentcode.ica.desktop",
    appPath: `${appOutDir}/ICA Desktop.app`,
    appleId,
    appleIdPassword,
    teamId,
  });
};
