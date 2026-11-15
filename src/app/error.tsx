"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { Btn, Section } from "@/components/kit";

/** Fallback for a crash in any page, inside the app shell so navigation still works. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Section index="!" title="Something went wrong">
      <p className="mb-4 text-sm text-muted-foreground">
        {error instanceof Error && error.message ? error.message : "This page hit an unexpected error."} Your saved
        rides and workouts are not affected.
      </p>
      <div>
        <Btn variant="solid" onClick={retry}>
          Try again
        </Btn>
      </div>
    </Section>
  );
}
