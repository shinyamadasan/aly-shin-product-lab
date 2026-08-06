"use client";

import type React from "react";
import type { ReactNode } from "react";
import { Globe, NotebookPen, Palette, Sparkles } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import type { BrandProfile } from "@/lib/product-lab-types";
import { Button, ColorSwatchField, FormPanel, Input, MessageBox, Select, Textarea } from "@/components/ui";

const BRAND_STATUS_OPTIONS = ["Exploring", "Provisional", "Final"];

// The fields that back this milestone's "one active brand record" -- the value type "email"
// only ever narrows Input's native type attribute, never widens it.
type BrandLinkInputName =
  | "websiteUrl"
  | "email"
  | "facebookHandle"
  | "facebookUrl"
  | "instagramHandle"
  | "instagramUrl"
  | "tiktokHandle"
  | "tiktokUrl"
  | "youtubeHandle"
  | "youtubeUrl";

// The small, reusable "brand link" render model the plan asked for: Brand Foundation renders
// this as a list rather than six near-identical hand-written blocks, so a future platform
// (Threads, Pinterest, LinkedIn, a menu link) is one more entry here plus one migration for its
// column(s) -- not a redesign of this page. websiteUrl/email have no separate handle input:
// a website's own URL is its display text; an email's mailto: link is derived in hrefFor,
// never stored.
type BrandLinkFieldConfig = {
  key: string;
  title: string;
  hrefFor: (profile: BrandProfile | null) => string;
  displayTextFor: (profile: BrandProfile | null) => string;
  inputs: Array<{ name: BrandLinkInputName; label: string; placeholder: string; type?: React.InputHTMLAttributes<HTMLInputElement>["type"] }>;
};

const BRAND_LINK_FIELDS: BrandLinkFieldConfig[] = [
  {
    key: "website",
    title: "Website",
    hrefFor: (profile) => profile?.websiteUrl ?? "",
    displayTextFor: (profile) => profile?.websiteUrl ?? "",
    inputs: [{ name: "websiteUrl", label: "Website URL", placeholder: "https://alyandpon.com" }],
  },
  {
    key: "email",
    title: "Email",
    hrefFor: (profile) => (profile?.email ? `mailto:${profile.email}` : ""),
    displayTextFor: (profile) => profile?.email ?? "",
    inputs: [{ name: "email", label: "Email address", placeholder: "hello@alyandpon.com", type: "email" }],
  },
  {
    key: "facebook",
    title: "Facebook",
    hrefFor: (profile) => profile?.facebookUrl ?? "",
    displayTextFor: (profile) => profile?.facebookHandle || profile?.facebookUrl || "",
    inputs: [
      { name: "facebookHandle", label: "Handle", placeholder: "@alyandpon" },
      { name: "facebookUrl", label: "URL", placeholder: "https://facebook.com/alyandpon" },
    ],
  },
  {
    key: "instagram",
    title: "Instagram",
    hrefFor: (profile) => profile?.instagramUrl ?? "",
    displayTextFor: (profile) => profile?.instagramHandle || profile?.instagramUrl || "",
    inputs: [
      { name: "instagramHandle", label: "Handle", placeholder: "@alyandpon" },
      { name: "instagramUrl", label: "URL", placeholder: "https://instagram.com/alyandpon" },
    ],
  },
  {
    key: "tiktok",
    title: "TikTok",
    hrefFor: (profile) => profile?.tiktokUrl ?? "",
    displayTextFor: (profile) => profile?.tiktokHandle || profile?.tiktokUrl || "",
    inputs: [
      { name: "tiktokHandle", label: "Handle", placeholder: "@alyandpon" },
      { name: "tiktokUrl", label: "URL", placeholder: "https://tiktok.com/@alyandpon" },
    ],
  },
  {
    key: "youtube",
    title: "YouTube",
    hrefFor: (profile) => profile?.youtubeUrl ?? "",
    displayTextFor: (profile) => profile?.youtubeHandle || profile?.youtubeUrl || "",
    inputs: [
      { name: "youtubeHandle", label: "Handle", placeholder: "@alyandpon" },
      { name: "youtubeUrl", label: "URL", placeholder: "https://youtube.com/@alyandpon" },
    ],
  },
];

// No Open/Copy buttons, per the approved enhancement -- the handle/URL itself IS the
// clickable control. Opens in a new tab so filling out the form never loses this page.
function BrandLinkField({ children, displayText, href, title }: { children: ReactNode; displayText: string; href: string; title: string }) {
  return (
    <div className="grid gap-2 border-b border-[#f0e6da] pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {href ? (
          <a className="text-sm font-medium text-[#8f5632] underline hover:text-[#6f4324]" href={href} rel="noreferrer" target="_blank">
            {displayText}
          </a>
        ) : (
          <span className="text-sm text-[#8a7465]">Not set</span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </div>
  );
}

export function BrandFoundationPage({
  isBrandFoundationColumnsMissing,
  labState,
  saveBrandProfile,
}: {
  isBrandFoundationColumnsMissing: boolean;
  labState: LabState;
  saveBrandProfile: (formData: FormData) => void;
}) {
  const brandProfile = labState.brandProfile;

  return (
    <section className="grid max-w-3xl gap-5">
      <p className="text-sm leading-6 text-[#6f5a4c]">
        The single source of truth for Aly & Pon&apos;s current branding decisions. Fill this out
        once so future content and AI work never has to guess what the business is, what it looks
        like, or who it&apos;s for.
      </p>

      {isBrandFoundationColumnsMissing ? (
        <MessageBox
          message="Some Brand Foundation fields aren't ready in the database yet. Run supabase-add-brand-foundation-fields.sql and supabase-add-brand-presence-fields.sql once, then save again."
          tone="info"
        />
      ) : null}

      <form action={saveBrandProfile} className="grid gap-5" key={brandProfile?.id ?? "new-brand-profile"}>
        <input name="id" type="hidden" value={brandProfile?.id ?? ""} />

        <FormPanel icon={<Sparkles size={18} />} title="General">
          <div className="grid gap-3">
            <Input defaultValue={brandProfile?.businessName} label="Business Name" name="businessName" placeholder="Aly & Pon" />
            <div className="grid gap-1">
              <Select
                defaultValue={brandProfile?.brandStatus ?? "Exploring"}
                label="Brand Status"
                name="brandStatus"
                options={BRAND_STATUS_OPTIONS}
              />
              <span className="text-xs font-normal leading-5 text-[#6f5a4c]">How settled these branding decisions are -- not the business&apos;s operating stage.</span>
            </div>
            <Input defaultValue={brandProfile?.shortDescription} label="One-line Brand Description" name="shortDescription" placeholder="Home-baked coffee and pastries, made fresh today." />
            <Textarea defaultValue={brandProfile?.targetAudience} label="Target Audience" name="targetAudience" placeholder="Who this is for." />
          </div>
        </FormPanel>

        <FormPanel icon={<Palette size={18} />} title="Visual Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorSwatchField defaultValue={brandProfile?.primaryColor} label="Primary Color" name="primaryColor" />
            <ColorSwatchField defaultValue={brandProfile?.secondaryColor} label="Secondary Color" name="secondaryColor" />
            <ColorSwatchField defaultValue={brandProfile?.backgroundColor} label="Background Color" name="backgroundColor" />
            <ColorSwatchField defaultValue={brandProfile?.accentColor} label="Accent Color" name="accentColor" />
          </div>
        </FormPanel>

        <FormPanel icon={<NotebookPen size={18} />} title="Brand Guidelines">
          <Textarea
            defaultValue={brandProfile?.brandGuidelines}
            helper="Overall aesthetic, photography style, design keywords, mood, inspiration, things to avoid -- whatever currently defines the look and feel."
            label="Current visual direction"
            name="brandGuidelines"
            rows={8}
          />
        </FormPanel>

        <FormPanel icon={<Globe size={18} />} title="Brand Presence">
          <div className="grid gap-4">
            <Input
              defaultValue={brandProfile?.preferredHandle}
              helper="The canonical @handle to use consistently across platforms -- reference text, not a link."
              label="Preferred Handle"
              name="preferredHandle"
              placeholder="@alyandpon"
            />
            {BRAND_LINK_FIELDS.map((field) => (
              <BrandLinkField key={field.key} displayText={field.displayTextFor(brandProfile)} href={field.hrefFor(brandProfile)} title={field.title}>
                {field.inputs.map((input) => (
                  <Input key={input.name} defaultValue={brandProfile?.[input.name]} label={input.label} name={input.name} placeholder={input.placeholder} type={input.type} />
                ))}
              </BrandLinkField>
            ))}
          </div>
        </FormPanel>

        <div>
          <Button>Save Brand Foundation</Button>
        </div>
      </form>
    </section>
  );
}
