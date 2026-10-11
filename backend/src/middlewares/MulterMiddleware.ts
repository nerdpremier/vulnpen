import { Request } from "express";
import multer from "multer";

// Allows only JPG and PNG files
const imageFilter = (
  req: Request,
  file: Express.Multer.File,
  callback: any
) => {
  if (
    (file.mimetype === "image/jpeg" || file.mimetype === "image/png") &&
    ["png", "jpg", "jpeg"].includes(
      file.originalname
        .split(".")
        [file.originalname.split(".").length - 1]?.toLowerCase()
    )
  ) {
    callback(null, true);
  } else {
    const error = new Error("Invalid file type, only JPG and PNG is allowed!");

    error.stack = "Invalid file type, only JPG and PNG is allowed!";

    error.name = "InvalidFileTypeError";

    callback(error, false);
  }
};

const openVPNFileFilter = (
  req: Request,
  file: Express.Multer.File,
  callback: any
) => {
  if (
    ["ovpn", "conf", "crt", "key", "pem", "p12", "pfx", "txt"].includes(
      file.originalname
        .split(".")
        [file.originalname.split(".").length - 1]?.toLowerCase()
    )
  ) {
    callback(null, true);
  } else {
    const error = new Error("Invalid VPN bundle file type");

    error.stack = "Allowed VPN bundle files: OVPN, CONF, CRT, KEY, PEM, P12, PFX, TXT";

    error.name = "InvalidFileTypeError";

    callback(error, false);
  }
};

const uploadImageMiddleware = multer({ fileFilter: imageFilter });
const uploadOpenVPNMiddleware = multer({
  fileFilter: openVPNFileFilter,
  limits: { fileSize: 2 * 1024 * 1024, files: 16 },
});

export {
  uploadImageMiddleware,
  uploadOpenVPNMiddleware,
};
