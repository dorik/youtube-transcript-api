import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../middleware/sessionAuth';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../services/apiKeyService';
import { ValidationError } from '../utils/errors';

export const apiKeysRouter = Router();

apiKeysRouter.use(sessionAuth);

apiKeysRouter.get('/', async (req, res, next) => {
  try {
    const keys = await listApiKeys(req.user!.id);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        prefix: k.key_prefix,
        name: k.name,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        is_revoked: k.is_revoked,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const CreateKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

apiKeysRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreateKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid request', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { key, plaintext } = await createApiKey(req.user!.id, parsed.data.name);
    res.status(201).json({
      // The plaintext is included ONCE on creation. Frontend should warn the
      // user this is the only time they'll see it.
      key: {
        id: key.id,
        prefix: key.key_prefix,
        name: key.name,
        created_at: key.created_at,
        last_used_at: null,
        is_revoked: false,
      },
      plaintext,
      warning: "Copy this key now. You won't be able to see it again.",
    });
  } catch (err) {
    next(err);
  }
});

apiKeysRouter.delete('/:keyId', async (req, res, next) => {
  try {
    await revokeApiKey(req.user!.id, req.params.keyId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
