import type { NextFunction, Request, Response } from "express";
import UserModel from "../models/User/User.model";

type OwnerIdLookup = () => Promise<unknown>;

async function findInstallationOwnerId(): Promise<unknown> {
  // Mongo ObjectIds are time ordered. Registration creates them server-side, so
  // the earliest User ObjectId is the authoritative owner for this installation.
  const owner = await UserModel.findOne({})
    .sort({ _id: 1 })
    .select({ _id: 1 })
    .lean();
  return owner?._id;
}

export async function isHostOwner(
  userId: unknown,
  lookup: OwnerIdLookup = findInstallationOwnerId,
): Promise<boolean> {
  if (userId == null) return false;
  const ownerId = await lookup();
  return ownerId != null && String(ownerId) === String(userId);
}

export function createRequireHostOwner(
  lookup: OwnerIdLookup = findInstallationOwnerId,
) {
  return async function requireHostOwner(
    _req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!(await isHostOwner(res.locals.userId, lookup))) {
      return res.status(403).json({
        message: "Only the installation owner can manage host-level integrations and credentials",
      });
    }
    next();
  };
}

export const requireHostOwner = createRequireHostOwner();
