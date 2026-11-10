// Shared by image-ref-core.test.ts and design-image-store.test.ts. Kept out of
// the test files so importing it does not run either suite twice.

// The `id` values below are what /api/drive-photo sees AFTER searchParams has
// decoded the query string once. A double-encoded "%252e%252e" arrives here as
// "%2e%2e", which URL normalisation would still turn into "..".
export const TRAVERSAL_REFS = [
  "sb:../buyer-cards/BUYER/card.jpg",
  "sb:../../../../rest/v1/staff_users?select=email,role",
  "sb:../../../../rest/v1/shopify_tokens?select=access_token",
  "sb:../../../../auth/v1/admin/users",
  "sb:design-images:../buyer-cards/BUYER/card.jpg",
  "sb:vendor-photos:../..",
  "sb:vendor-photos:../../../../rest/v1/buyers",
  "sb:order-attachments:x/../../receipt-photos/R/bill.jpg",
  "sb:note-photos:./x.jpg",
  "sb:%2e%2e/buyer-cards/BUYER/card.jpg",
  "sb:%2E%2E/%2E%2E/%2E%2E/%2E%2E/rest/v1/buyers",
  "sb:.%2E/buyer-cards/BUYER/card.jpg",
  "sb:%2e./buyer-cards/BUYER/card.jpg",
  "sb:..%2fbuyer-cards%2fBUYER%2fcard.jpg",
  "sb:vendor-photos:%2e%2e/%2e%2e",
  "sb:..\\buyer-cards\\BUYER\\card.jpg",
  "sb:x\\..\\..\\..\\..\\rest\\v1\\buyers", // https URLs read "\" as "/"
  "sb:..",
  "sb:.",
  "sb:x/..",
  "sb:x/.",
];

// Malformed rather than malicious, refused all the same: nothing the portal
// writes looks like this.
export const MALFORMED_REFS = [
  "sb:",
  "sb:vendor-photos",
  "sb:vendor-photos:",
  "sb:/abs.jpg",
  "sb:a//b.jpg",
  "sb:a/b.jpg/",
  "sb:a/b.jpg?download=1",
  "sb:a/b.jpg#frag",
  "sb:a/b c.jpg",
  "sb:a/b\tc.jpg",
  "sb:a/b\u0000.jpg",
  "sb:．．/buyer-cards/BUYER/card.jpg", // fullwidth full stops: not a dot segment, but not ASCII either
  "sb:unknown-bucket:a/b.jpg",
];

// Every shape the portal writes (storeDesignImage, archiveImageFile,
// storeAuxPhoto in vendors / orders / notes) and every shape found in the dev
// and prod databases on 7 Nov 2026. [ref, bucket, path]
export const REAL_REFS: Array<[string, string, string]> = [
  ["sb:6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/front__src__01.jpg", "design-images", "6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/front__src__01.jpg"],
  ["sb:6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/design__ident__02.png", "design-images", "6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/design__ident__02.png"],
  ["sb:6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/_archive/front__src__01-1730956800000.jpg", "design-images", "6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/_archive/front__src__01-1730956800000.jpg"],
  ["sb:design-images:6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/back__crop__03.jpg", "design-images", "6f1c2a9e-0b7d-4f43-9a51-3c2e8d7b1a00/back__crop__03.jpg"],
  ["sb:vendor-photos:2b8e0f6a-91c4-4d0e-8b1f-5a7c3e9d2f11/card-1730956800000.png", "vendor-photos", "2b8e0f6a-91c4-4d0e-8b1f-5a7c3e9d2f11/card-1730956800000.png"],
  ["sb:vendor-photos:2b8e0f6a-91c4-4d0e-8b1f-5a7c3e9d2f11/person-1730956800000.jpg", "vendor-photos", "2b8e0f6a-91c4-4d0e-8b1f-5a7c3e9d2f11/person-1730956800000.jpg"],
  ["sb:order-attachments:9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/tracking-1730956800000.jpg", "order-attachments", "9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/tracking-1730956800000.jpg"],
  ["sb:note-photos:order/9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/1730956800000-k3x9q.jpg", "note-photos", "order/9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/1730956800000-k3x9q.jpg"],
  ["sb:note-photos:buyer/9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/1730956800000-abcde.png", "note-photos", "buyer/9d3f6b2c-7e1a-4c5b-a8d9-0f2e4b6c8a13/1730956800000-abcde.png"],
];
