'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiKeys, type ApiKey } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/apiError';
import { rememberKey, forgetKey } from '@/lib/key-stash';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [loading, setLoading] = useState(true);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);

  // Reveal dialog state (shown once after creation)
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  async function refresh() {
    try {
      const { keys } = await apiKeys.list();
      setKeys(keys);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Could not load keys'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { key, plaintext } = await apiKeys.create({
        name: newKeyName.trim() || undefined,
      });
      // Stash plaintext in localStorage so the playground / viewer can offer
      // it as a dropdown option without making the user paste each time.
      rememberKey({
        id: key.id,
        prefix: key.prefix ?? null,
        name: key.name,
        plaintext,
      });
      setCreateOpen(false);
      setNewKeyName('');
      setRevealedKey(plaintext);
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Could not create key'));
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(keyId: string) {
    if (!confirm('Revoke this key? Any apps using it will start getting 401s immediately.')) {
      return;
    }
    try {
      await apiKeys.revoke(keyId);
      forgetKey(keyId);
      toast.success('Key revoked');
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Could not revoke key'));
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-muted-foreground text-sm">
            Use these keys with <code className="font-mono">Authorization: Bearer …</code> headers.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create key</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !keys?.length ? (
            <p className="text-sm text-muted-foreground">
              You don&apos;t have any keys yet. Create one to start using the API.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Key</th>
                    <th className="py-2 pr-4 font-medium">Created</th>
                    <th className="py-2 pr-4 font-medium">Last used</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b last:border-0">
                      <td className="py-3 pr-4">{k.name ?? 'Untitled'}</td>
                      <td className="py-3 pr-4 font-mono text-xs">
                        yt_live_{k.prefix}…
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
                        {new Date(k.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
                        {k.last_used_at
                          ? new Date(k.last_used_at).toLocaleDateString()
                          : 'never'}
                      </td>
                      <td className="py-3 pr-4">
                        {k.is_revoked ? (
                          <span className="text-xs text-muted-foreground">revoked</span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            active
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {!k.is_revoked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => onRevoke(k.id)}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give your key a name so you remember what it&apos;s for (e.g. &quot;Production&quot;).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              autoFocus
              placeholder="e.g. Production"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onCreate} disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal dialog: shown once after creation */}
      <Dialog open={!!revealedKey} onOpenChange={(open) => !open && setRevealedKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
            <DialogDescription>
              This is the only time we&apos;ll show this key. Store it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 font-mono text-xs break-all">
            {revealedKey}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => revealedKey && copy(revealedKey)}>
              Copy
            </Button>
            <Button onClick={() => setRevealedKey(null)}>I&apos;ve copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
