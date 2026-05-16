'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';
import { extractVideoId } from '@/lib/youtube-url';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  useCreateBatchMutation,
  useCreateTranscriptMutation,
} from '@/features/transcripts';

/** True for a playlist or channel URL — routed to the bulk endpoint. */
function isBulkUrl(input: string): boolean {
  return (
    /[?&]list=/.test(input) ||
    /youtube\.com\/(@|channel\/|c\/|user\/)/.test(input)
  );
}

/**
 * Submit a transcript request to the async queue. Submitting does not block
 * or navigate away — the field clears so the user can immediately queue the
 * next URL. Playlist/channel URLs are sent to the bulk endpoint.
 */
export default function NewTranscriptPage() {
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('');
  const [translateTo, setTranslateTo] = useState('');

  const createMutation = useCreateTranscriptMutation();
  const batchMutation = useCreateBatchMutation();
  const submitting = createMutation.isPending || batchMutation.isPending;

  function sharedConfig() {
    return {
      language: language.trim() || undefined,
      translate_to:
        translateTo.trim() && translateTo !== 'none'
          ? translateTo.trim()
          : undefined,
    };
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    if (isBulkUrl(trimmed)) {
      const isPlaylist = /[?&]list=/.test(trimmed);
      batchMutation.mutate(
        {
          ...(isPlaylist ? { playlist: trimmed } : { channel: trimmed }),
          ...sharedConfig(),
        },
        {
          onSuccess: (res) => {
            toast.success(
              `Queued ${res.requests.length} videos from the ${
                isPlaylist ? 'playlist' : 'channel'
              }.`,
            );
            setUrl('');
          },
          onError: (err) =>
            toast.error(getApiErrorMessage(err, 'Could not queue the batch')),
        },
      );
      return;
    }

    if (!extractVideoId(trimmed)) {
      toast.error("That doesn't look like a YouTube URL or video id.");
      return;
    }
    createMutation.mutate(
      { url: trimmed, ...sharedConfig() },
      {
        onSuccess: () => {
          toast.success('Added to the queue.');
          setUrl('');
        },
        onError: (err) =>
          toast.error(getApiErrorMessage(err, 'Could not queue the request')),
      },
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to transcripts
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">New transcript</h1>
        <p className="text-muted-foreground text-sm">
          Paste a YouTube video, playlist, or channel URL. Requests run in the
          background — submit as many as you like; track them on the
          transcripts page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queue a transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="url">YouTube video, playlist, or channel URL</Label>
              <Input
                id="url"
                type="text"
                required
                placeholder="https://youtu.be/dQw4w9WgXcQ"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <div className="space-y-2">
                <Label htmlFor="language">Source language</Label>
                <Input
                  id="language"
                  placeholder="auto"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="translate-to">Translate to</Label>
                <SearchableSelect
                  id="translate-to"
                  value={translateTo || 'none'}
                  onValueChange={(v) => setTranslateTo(v === 'none' ? '' : v)}
                  options={TARGET_LANGUAGE_OPTIONS.map((l) => ({
                    value: l.code,
                    label: l.label,
                  }))}
                  searchPlaceholder="Search languages…"
                />
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Queuing…' : 'Add to queue'}
              </Button>
            </div>
          </form>
          <p className="text-xs text-muted-foreground mt-3">
            Costs 1 credit per fresh transcript (cached videos are free).
            Translation costs <strong>+1 credit</strong> per video.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
