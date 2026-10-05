import { Response, Request } from "express";
import { readEnvFile, updateEnvVars } from "../utils/envWriter";

export const getSSHConfig = async (_req: Request, res: Response) => {
  try {
    const env = readEnvFile();
    const user = res.locals.user;

    return res.status(200).json({
      host: env.SSH_HOST || "",
      port: env.SSH_PORT || "22",
      username: env.SSH_USERNAME || "",
      authMethod: env.SSH_PRIVATE_KEY ? "key" : "password",
      // Never send the credential itself back to the client.
      hasPassword: !!env.SSH_PASSWORD,
      hasPrivateKey: !!env.SSH_PRIVATE_KEY,
      configured: !!(env.SSH_HOST && env.SSH_USERNAME),
      disableSafetyProtections:
        user?.configs?.disableSafetyProtections ?? false,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to get SSH config" });
  }
};

export const updateSSHConfig = async (req: Request, res: Response) => {
  try {
    const {
      host,
      port,
      username,
      authMethod,
      password,
      privateKeyPath,
      passphrase,
      disableSafetyProtections,
    } = req.body;

    if (!host || !username) {
      return res
        .status(400)
        .json({ message: "Host and username are required" });
    }

    const env = readEnvFile();
    const updates: Record<string, string> = {
      SSH_HOST: host,
      SSH_PORT: String(port || 22),
      SSH_USERNAME: username,
    };

    if (authMethod === "key") {
      updates.SSH_PRIVATE_KEY = privateKeyPath || env.SSH_PRIVATE_KEY || "";
      updates.SSH_PRIVATE_KEY_PASSPHRASE =
        passphrase || env.SSH_PRIVATE_KEY_PASSPHRASE || "";
      updates.SSH_PASSWORD = "";
    } else {
      updates.SSH_PASSWORD = password || env.SSH_PASSWORD || "";
      updates.SSH_PRIVATE_KEY = "";
      updates.SSH_PRIVATE_KEY_PASSPHRASE = "";
    }

    updateEnvVars(updates);

    if (typeof disableSafetyProtections === "boolean") {
      const user = res.locals.user;
      user.configs.disableSafetyProtections = disableSafetyProtections;
      await user.save();
    }

    return res.status(200).json({ message: "SSH configuration updated" });
  } catch (error) {
    console.log(error);
    return res.status(400).json({ message: "Failed to update SSH config" });
  }
};
