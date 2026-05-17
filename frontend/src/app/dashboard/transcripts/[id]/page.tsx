"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/apiError";
import { TranscriptViewer } from "@/features/transcript-viewer";
import {
  useCreateTranscriptMutation,
  useTranscriptRequestQuery,
} from "@/features/transcripts";

/**
 * Viewer for one transcript request. While the request is queued/processing
 * it shows a live status card; once `completed` it renders the stored
 * `result`. Picking a new translation target queues a fresh request but keeps
 * the current transcript on screen — the language dropdown is disabled and
 * shows a loading state — until that request completes, at which point the
 * viewer hands off to the new transcript's page.
 */
export default function TranscriptViewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  // While a translation is in flight we keep the current transcript on
  // screen and poll the newly-queued request here, rather than navigating to
  // its (still-empty) page.
  const [pendingTranslationId, setPendingTranslationId] = useState<
    string | null
  >(null);

  const requestQuery = useTranscriptRequestQuery(id, !!id);
  const createMutation = useCreateTranscriptMutation();
  const pendingQuery = useTranscriptRequestQuery(
    pendingTranslationId ?? "",
    pendingTranslationId !== null,
  );

  const request = requestQuery.data;
  const loading = requestQuery.isLoading;
  const errorMsg = requestQuery.error
    ? getApiErrorMessage(requestQuery.error, "Could not load this request")
    : null;
  const pendingRequest = pendingQuery.data;
  const pendingError = pendingQuery.error;
  // True from the moment the user picks a language until the queued
  // translation resolves — keeps the dropdown disabled and showing `…`.
  const isTranslating =
    createMutation.isPending || pendingTranslationId !== null;

  const handleRetry = useCallback(() => {
    if (!request) return;
    createMutation.mutate(request.request, {
      onSuccess: (next) => router.push(`/dashboard/transcripts/${next.id}`),
      onError: (err) => toast.error(getApiErrorMessage(err, "Retry failed")),
    });
  }, [createMutation, request, router]);

  const onTranslateTargetChange = useCallback(
    (target: string | null) => {
      if (!request) return;
      createMutation.mutate(
        {
          url: request.request.url,
          language: request.request.language,
          translate_to: target ?? undefined,
        },
        {
          onSuccess: (next) => {
            setPendingTranslationId(next.id);
          },
          onError: (err) =>
            toast.error(getApiErrorMessage(err, "Could not queue translation")),
        },
      );
    },
    [createMutation, request],
  );

  // Once the queued translation finishes, hand off to its own page — by then
  // the request is cached and `completed`, so the viewer renders straight
  // away with the requested language and no intermediate "Transcribing…"
  // card. A failed/canceled translation (or an unreachable request) surfaces
  // a toast and leaves the current transcript in place.
  useEffect(() => {
    if (pendingTranslationId === null) return;
    if (pendingError && !pendingRequest) {
      toast.error(
        getApiErrorMessage(pendingError, "Could not load the translation"),
      );
      setPendingTranslationId(null);
      return;
    }
    if (!pendingRequest) return;
    if (pendingRequest.status === "completed") {
      setPendingTranslationId(null);
      router.push(`/dashboard/transcripts/${pendingTranslationId}`);
    } else if (
      pendingRequest.status === "failed" ||
      pendingRequest.status === "canceled"
    ) {
      toast.error(
        pendingRequest.error_message ??
          "The translation could not be completed.",
      );
      setPendingTranslationId(null);
    }
  }, [pendingTranslationId, pendingRequest, pendingError, router]);

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/transcripts">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to transcripts
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/transcripts/new">New transcript</Link>
        </Button>
      </div>

      {loading && !request && (
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
              <Skeleton className="aspect-video" />
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {errorMsg && !loading && !request && (
        <Card>
          <CardContent className="p-6">
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-medium mb-1">Could not load this request</p>
              <p>{errorMsg}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {request &&
        (request.status === "queued" || request.status === "processing") && (
          <Card>
            <CardContent className="p-8 text-center space-y-2">
              <p className="font-semibold">
                {request.status === "queued"
                  ? "Waiting in the queue…"
                  : "Transcribing…"}
              </p>
              <p className="text-sm text-muted-foreground">
                {request.title ?? request.request.url}
              </p>
              <p className="text-xs text-muted-foreground">
                This page updates automatically when it&apos;s ready.
              </p>
            </CardContent>
          </Card>
        )}

      {request && request.status === "failed" && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-medium mb-1">This transcript failed</p>
              <p>{request.error_message ?? "Unknown error."}</p>
            </div>
            <Button
              variant="outline"
              disabled={createMutation.isPending}
              onClick={handleRetry}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {request && request.status === "canceled" && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            This request was canceled.
          </CardContent>
        </Card>
      )}

      {request && request.status === "completed" && request.result && (
        <TranscriptViewer
          data={request.result}
          onTranslateTargetChange={onTranslateTargetChange}
          isRefetching={isTranslating}
        />
      )}
    </div>
  );
}
