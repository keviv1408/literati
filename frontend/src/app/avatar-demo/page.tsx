"use client";

/**
 * Avatar demo page — visual playground for the Avatar component.
 * Visit /avatar-demo during development to preview all sizes and edge cases.
 */
import Avatar from "@/components/Avatar";

const SAMPLE_NAMES = [
  "Alice Johnson",
  "Bob Smith",
  "Carol Green",
  "David Kim",
  "Eve Martinez",
  "Frank O'Brien",
  "Grace Liu",
  "Hank Patel",
  "Bot #1",
  "Bot #2",
  "Bot #3",
  "Spectator",
  "Player",
  "J",
  "42",
  "",
];

const SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

export default function AvatarDemoPage() {
  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-3xl font-bold mb-8">Avatar Component Demo</h1>

      {/* Size variants */}
      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4 text-gray-300">
          Sizes (Alice Johnson)
        </h2>
        <div className="flex items-end gap-6 flex-wrap">
          {SIZES.map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <Avatar displayName="Alice Johnson" size={size} showTooltip />
              <span className="text-xs text-gray-400">{size}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Colour distribution */}
      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4 text-gray-300">
          Colour distribution — 16 sample names
        </h2>
        <div className="flex flex-wrap gap-4">
          {SAMPLE_NAMES.map((name) => (
            <div key={name} className="flex flex-col items-center gap-1">
              <Avatar displayName={name} size="md" showTooltip />
              <span className="text-xs text-gray-400 max-w-[60px] text-center truncate">
                {name || "(empty)"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Image URL fallback */}
      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4 text-gray-300">
          Image URL override (broken URL → falls back to initials on error)
        </h2>
        <div className="flex gap-6 items-center flex-wrap">
          <div className="flex flex-col items-center gap-1">
            <Avatar
              displayName="Alice"
              imageUrl="https://i.pravatar.cc/80?img=1"
              size="lg"
              showTooltip
            />
            <span className="text-xs text-gray-400">valid image</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Avatar
              displayName="Bob"
              imageUrl="https://this-url-does-not-exist.invalid/pic.jpg"
              size="lg"
              showTooltip
            />
            <span className="text-xs text-gray-400">broken URL</span>
          </div>
        </div>
      </section>
    </main>
  );
}
