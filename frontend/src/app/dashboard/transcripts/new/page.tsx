'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TARGET_LANGUAGE_OPTIONS } from '@/lib/languages';
import { extractVideoId } from '@/lib/youtube-url';

/**
 * Form page that takes a YouTube URL plus optional source language and
 * translation target, then routes to the path-based viewer
 * /dashboard/transcripts/[videoId]?language=&translate_to=.
 */
export default function NewTranscriptPage() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('');
  const [translateTo, setTranslateTo] = useState('');

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const videoId = extractVideoId(url);
    if (!videoId) {
      toast.error("That doesn't look like a YouTube URL or video id.");
      return;
    }
    const next = new URLSearchParams();
    if (language.trim()) next.set('language', language.trim());
    if (translateTo.trim() && translateTo !== 'none') {
      next.set('translate_to', translateTo.trim());
    }
    const qs = next.toString();
    router.push(`/dashboard/transcripts/${videoId}${qs ? `?${qs}` : ''}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to history
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">New transcript</h1>
        <p className="text-muted-foreground text-sm">
          Paste a YouTube URL to fetch the transcript. Costs 1 credit per
          native-caption video, plus 1 extra if translating.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Load a transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="url">YouTube URL or video ID</Label>
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
                <Label>Translate to</Label>
                <Select
                  value={translateTo || 'none'}
                  onValueChange={(v) => setTranslateTo(v === 'none' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {TARGET_LANGUAGE_OPTIONS.map((l) => (
                      <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit">Load</Button>
            </div>
          </form>
          <p className="text-xs text-muted-foreground mt-3">
            Uses your dashboard session and your account&apos;s credit balance.
            Translation costs <strong>+1 credit</strong> per video.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
