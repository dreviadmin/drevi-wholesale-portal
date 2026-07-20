// SKU vocabularies — the single source for categories, sub-categories, colors
// and sizes (the old Apps Script tool duplicated these client + server; the
// portal must not repeat that mistake). Copied verbatim from the Phase 1 spec.

export const CATEGORIES = {
  SAR: { name: 'Saree', subs: { TRD:'Traditional Drape', PRD:'Pre-Draped', SGW:'Saree Gown',
    RFL:'Ruffle Saree', HLF:'Half Saree', PNT:'Pant Saree', OTH:'Other' } },
  LEH: { name: 'Lehenga', subs: { ALN:'A-Line', FLR:'Flared / Kali', MRM:'Mermaid',
    STR:'Straight / Pencil', SHR:'Sharara Lehenga', LSR:'Lehenga Saree', OTH:'Other' } },
  SUT: { name: 'Suit Set', subs: { ANK:'Anarkali', STR:'Straight Suit', SHR:'Sharara Set',
    GHR:'Gharara Set', PLZ:'Palazzo Suit', FLR:'Floor-Length Suit', PEP:'Peplum Suit', OTH:'Other' } },
  GWN: { name: 'Gown', subs: { FLR:'Floor-Length', ALN:'A-Line', MRM:'Mermaid', BLL:'Ball Gown',
    CAP:'Cape Gown', TRL:'Trail Gown', IDW:'Indo-Western Gown', OTH:'Other' } },
  IWS: { name: 'Indo-Western Set', subs: { JKT:'Jacket Set', CRP:'Crop Set', CAP:'Cape Set',
    DHT:'Dhoti Set', PNT:'Pant Set', BLZ:'Blazer Set', OTH:'Other' } },
  KUR: { name: 'Kurta / Kurti', subs: { STR:'Straight', ALN:'A-Line', SHT:'Shirt Kurta',
    KFT:'Kaftan', TUN:'Tunic', ASM:'Asymmetric', OTH:'Other' } },
  SEP: { name: 'Separates', subs: { SKT:'Skirt', PLZ:'Palazzo', PNT:'Pants / Trousers',
    BLS:'Blouse', JKT:'Jacket / Shrug', DUP:'Dupatta', CAP:'Cape', OTH:'Other' } },
  OTH: { name: 'Other', subs: { OTH:'Other' } },
} as const;

export const COLOR_GROUPS = [
  { name:'Neutrals', items:[['BLK','Black'],['WHT','White'],['IVR','Ivory'],['CRM','Cream'],
    ['BGE','Beige'],['GRY','Grey'],['BRN','Brown'],['TAU','Taupe'],['CHM','Champagne'],['KHK','Khaki']] },
  { name:'Reds & Pinks', items:[['RED','Red'],['MRN','Maroon'],['WIN','Wine'],['PNK','Pink'],
    ['BLS','Blush'],['PCH','Peach'],['CRL','Coral'],['ROS','Rose'],['FCH','Fuchsia']] },
  { name:'Oranges & Yellows', items:[['ORG','Orange'],['RST','Rust'],['MUS','Mustard'],
    ['YLW','Yellow'],['GLD','Gold']] },
  { name:'Greens', items:[['GRN','Green'],['OLV','Olive'],['SGE','Sage'],['MNT','Mint'],
    ['EMR','Emerald'],['TLG','Teal'],['FST','Forest Green']] },
  { name:'Blues', items:[['BLU','Blue'],['NVY','Navy'],['RBL','Royal Blue'],['SKY','Sky Blue'],
    ['PBL','Powder Blue'],['TRQ','Turquoise']] },
  { name:'Purples', items:[['PUR','Purple'],['LAV','Lavender'],['LIL','Lilac'],['PLM','Plum'],['MAV','Mauve']] },
  { name:'Metallics & Misc', items:[['SLV','Silver'],['CPR','Copper'],['MLT','Multi'],['OTH','Other']] },
] as const;

export const SIZES = {
  XS:'XS', S:'S', M:'M', L:'L', XL:'XL', XXL:'XXL', XXXL:'XXXL',
  '32':'32','34':'34','36':'36','38':'38','40':'40','42':'42','44':'44','46':'46',
  FS:'Free Size', CTM:'Custom / Made to Measure', OTH:'Other',
} as const;

// Derived lookups (shared by client UI and API validation).
export type CategoryCode = keyof typeof CATEGORIES;
export const ALL_COLOR_CODES: ReadonlySet<string> = new Set(
  COLOR_GROUPS.flatMap((g) => g.items.map(([code]) => code)),
);
export const ALL_SIZE_CODES: ReadonlySet<string> = new Set(Object.keys(SIZES));

export function isValidCatSub(cat: string, sub: string): boolean {
  const c = (CATEGORIES as Record<string, { subs: Record<string, string> }>)[cat];
  return !!c && sub in c.subs;
}

export const BASE_SKU_RE = /^DD-[A-Z]{2,4}-[A-Z0-9]{2,4}-\d{3}$/;
