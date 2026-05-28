import React, { useState } from 'react';
import { Search, ShoppingBag, Menu, X, Eye, EyeOff, ChevronDown, Plus, Filter, LogOut, ChevronRight, Smartphone, Tablet } from 'lucide-react';

// ────────────────────────────────────────────────────────────
//  DREVI WHOLESALE PORTAL — CATALOG SCREEN PROTOTYPE
//  Single screen, two views (Buyer / Mobile, Exhibition / Tablet)
//  Royal Noir palette · Playfair Display + Montserrat
// ────────────────────────────────────────────────────────────

const palette = {
  black: '#1A1A1A',
  softBlack: '#2D2926',
  gold: '#C4A35A',
  goldDeep: '#A88848',
  ivory: '#FAF6F0',
  ivoryDeep: '#F2EBDC',
  champagne: '#E8D5B7',
};

const CATEGORIES = ['All', 'Sarees', 'Lehengas', 'Indo-Western', 'Co-ords', 'Drape Skirts', 'Jackets'];

// Stylized gradient palettes per garment "hue" — no external images, all CSS
const HUES = {
  sage:      ['#9CAE93', '#6F8467'],
  teal:      ['#2E5F5F', '#1A4040'],
  maroon:    ['#6B2222', '#42110F'],
  noir:      ['#2A2A2A', '#0E0E0E'],
  ivory:     ['#EBDFC8', '#C8B690'],
  gold:      ['#C4A35A', '#8B6F2E'],
  crimson:   ['#8C2331', '#4F0E18'],
  champagne: ['#E0CFAA', '#B89F6E'],
  royal:     ['#1E3A6D', '#0C1E40'],
  emerald:   ['#2F6F4A', '#13402A'],
  dustyrose: ['#C49AA0', '#8A6168'],
  charcoal:  ['#3C3236', '#1A1416'],
};

const PRODUCTS = [
  { sku: 'DD-LEH-SET-014', title: 'Sage Heirloom Lehenga Set',     category: 'Lehengas',      price: 4200, moq: null, stock: 7, restockable: true,  restock_days: null, hue: 'sage' },
  { sku: 'DD-SAR-CHK-029', title: 'Teal Chikankari Drape',         category: 'Sarees',        price: 2800, moq: 3,    stock: 12, restockable: true, restock_days: null, hue: 'teal' },
  { sku: 'DD-IWS-CRD-008', title: 'Maroon Velvet Co-ord',          category: 'Co-ords',       price: 2500, moq: null, stock: 3,  restockable: false, restock_days: null, hue: 'maroon' },
  { sku: 'DD-SAR-SEQ-041', title: 'Noir Sequined Saree Gown',      category: 'Sarees',        price: 5400, moq: null, stock: 0,  restockable: true,  restock_days: 14, hue: 'noir' },
  { sku: 'DD-LEH-BRD-003', title: 'Ivory Bridal Lehenga',          category: 'Lehengas',      price: 18200, moq: null, stock: 2, restockable: false, restock_days: null, hue: 'ivory' },
  { sku: 'DD-JKL-EMB-011', title: 'Antique Gold Embellished Jacket', category: 'Jackets',     price: 3600, moq: 2,    stock: 0,  restockable: true,  restock_days: 7,  hue: 'gold' },
  { sku: 'DD-IWS-SET-022', title: 'Crimson Indo-Western Set',      category: 'Indo-Western',  price: 3900, moq: null, stock: 9,  restockable: true,  restock_days: null, hue: 'crimson' },
  { sku: 'DD-DSK-RAW-005', title: 'Champagne Raw Silk Drape Skirt', category: 'Drape Skirts', price: 2100, moq: 3,    stock: 14, restockable: true, restock_days: null, hue: 'champagne' },
  { sku: 'DD-IWS-ANK-017', title: 'Royal Blue Anarkali',           category: 'Indo-Western',  price: 4400, moq: null, stock: 0,  restockable: false, restock_days: null, hue: 'royal' },
  { sku: 'DD-IWS-KRT-031', title: 'Emerald Kurta Palazzo',         category: 'Indo-Western',  price: 2900, moq: null, stock: 6,  restockable: true,  restock_days: null, hue: 'emerald' },
  { sku: 'DD-IWS-CRD-026', title: 'Dusty Rose Co-ord',             category: 'Co-ords',       price: 2700, moq: null, stock: 0,  restockable: true,  restock_days: 10, hue: 'dustyrose' },
  { sku: 'DD-LEH-VLT-009', title: 'Charcoal Velvet Lehenga',       category: 'Lehengas',      price: 9800, moq: null, stock: 1,  restockable: false, restock_days: null, hue: 'charcoal' },
];

function getStockState(p) {
  if (p.stock > 0 && p.restockable)  return 'ready';
  if (p.stock > 0 && !p.restockable) return 'limited';
  if (p.stock === 0 && p.restockable) return 'made_to_order';
  return 'sold_out';
}

// ────────────────────────────────────────────────────────────
//  STOCK PILL — the central design language piece
// ────────────────────────────────────────────────────────────
function StockPill({ product, compact = false }) {
  const state = getStockState(product);

  const base = "inline-flex items-center gap-1.5 font-body uppercase tracking-[0.12em]";
  const size = compact ? "text-[9px] px-2 py-0.5" : "text-[10px] px-2.5 py-1";

  if (state === 'ready') {
    return (
      <span className={base + ' ' + size} style={{ color: palette.softBlack }}>
        <span style={{ width: 6, height: 6, borderRadius: 9, background: palette.gold, display: 'inline-block' }} />
        In Stock
      </span>
    );
  }
  if (state === 'limited') {
    return (
      <span className={base + ' ' + size} style={{ color: palette.crimson || '#8C2331', background: '#FBEDEE', border: `1px solid #E8C7CC` }}>
        Limited · {product.stock} left
      </span>
    );
  }
  if (state === 'made_to_order') {
    return (
      <span className={base + ' ' + size} style={{ color: palette.goldDeep, border: `1px solid ${palette.gold}` }}>
        Made to Order · {product.restock_days}d
      </span>
    );
  }
  return (
    <span className={base + ' ' + size} style={{ color: '#888', background: '#EFEAE0' }}>
      Sold Out
    </span>
  );
}

// ────────────────────────────────────────────────────────────
//  PRODUCT IMAGE — stylized CSS placeholder (gradient + name)
// ────────────────────────────────────────────────────────────
function ProductImage({ product, large = false }) {
  const [c1, c2] = HUES[product.hue] || HUES.sage;
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: '4/5',
        background: `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
      }}
    >
      {/* subtle grain */}
      <div
        className="absolute inset-0 opacity-20 mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><filter id='n'><feTurbulence baseFrequency='0.9'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")"
        }}
      />
      {/* DREVI watermark */}
      <div
        className="absolute top-3 left-3 font-display"
        style={{ color: 'rgba(255,255,255,0.55)', fontSize: large ? 11 : 9, letterSpacing: '0.25em' }}
      >
        DREVI
      </div>
      {/* SKU bottom right */}
      <div
        className="absolute bottom-3 right-3 font-body"
        style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, letterSpacing: '0.1em' }}
      >
        {product.sku}
      </div>
      {/* Centered title in editorial serif */}
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <div
          className="font-display text-center"
          style={{
            color: 'rgba(255,255,255,0.92)',
            fontSize: large ? 22 : 16,
            lineHeight: 1.15,
            fontWeight: 500,
            letterSpacing: '0.01em',
            textShadow: '0 2px 12px rgba(0,0,0,0.25)',
          }}
        >
          {product.title.split(' ').slice(0, 2).join(' ')}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  PRODUCT CARD
// ────────────────────────────────────────────────────────────
function ProductCard({ product, showPrices, large = false }) {
  const state = getStockState(product);
  const canAdd = state !== 'sold_out';

  return (
    <div
      className="flex flex-col"
      style={{ background: palette.ivory, border: `1px solid rgba(26,26,26,0.06)` }}
    >
      <ProductImage product={product} large={large} />

      <div className={large ? "px-4 pt-4 pb-4" : "px-3 pt-3 pb-3"}>
        {/* Title */}
        <div
          className="font-display"
          style={{
            color: palette.black,
            fontSize: large ? 15 : 13,
            lineHeight: 1.25,
            fontWeight: 500,
            minHeight: large ? 38 : 32,
          }}
        >
          {product.title}
        </div>

        {/* SKU */}
        <div
          className="font-body mt-0.5"
          style={{ color: '#998F7A', fontSize: 9, letterSpacing: '0.1em' }}
        >
          {product.sku}
        </div>

        {/* Stock pill */}
        <div className="mt-2.5">
          <StockPill product={product} compact={!large} />
        </div>

        {/* Price row */}
        <div className="mt-3 flex items-baseline justify-between gap-2">
          {showPrices ? (
            <div
              className="font-display"
              style={{ color: palette.black, fontSize: large ? 18 : 16, fontWeight: 600, letterSpacing: '0.01em' }}
            >
              ₹{product.price.toLocaleString('en-IN')}
            </div>
          ) : (
            <div
              className="font-body"
              style={{ color: '#998F7A', fontSize: 11, letterSpacing: '0.1em' }}
            >
              ——
            </div>
          )}
        </div>

        {/* MOQ */}
        {product.moq && (
          <div
            className="font-body mt-1"
            style={{ color: palette.goldDeep, fontSize: 10, letterSpacing: '0.05em' }}
          >
            Minimum {product.moq} pieces
          </div>
        )}

        {/* Add button */}
        <button
          disabled={!canAdd}
          className="mt-3 w-full flex items-center justify-center gap-1.5 font-body uppercase transition-colors"
          style={{
            color: canAdd ? palette.ivory : '#AAA',
            background: canAdd ? palette.black : '#E6E0D0',
            fontSize: 10,
            letterSpacing: '0.2em',
            padding: large ? '10px 0' : '9px 0',
            cursor: canAdd ? 'pointer' : 'not-allowed',
          }}
        >
          {canAdd ? <><Plus size={11} strokeWidth={2.5} /> Add to Cart</> : 'Unavailable'}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  BUYER MOBILE VIEW
// ────────────────────────────────────────────────────────────
function BuyerMobile({ category, setCategory, showPrices, filtered, cartCount }) {
  return (
    <div className="flex flex-col h-full" style={{ background: palette.ivory }}>
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-3.5 sticky top-0 z-10"
        style={{ background: palette.ivory, borderBottom: `1px solid rgba(26,26,26,0.08)` }}
      >
        <button><Menu size={20} color={palette.black} strokeWidth={1.5} /></button>
        <div className="font-display" style={{ fontSize: 17, letterSpacing: '0.35em', color: palette.black, fontWeight: 600 }}>
          DREVI
        </div>
        <div className="flex items-center gap-3">
          <Search size={19} color={palette.black} strokeWidth={1.5} />
          <div className="relative">
            <ShoppingBag size={19} color={palette.black} strokeWidth={1.5} />
            {cartCount > 0 && (
              <div
                className="absolute -top-1.5 -right-1.5 flex items-center justify-center font-body"
                style={{ background: palette.gold, color: palette.black, fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: 8 }}
              >
                {cartCount}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sub-bar: buyer identity */}
      <div className="px-4 py-2.5" style={{ background: palette.ivoryDeep }}>
        <div className="font-body" style={{ color: palette.softBlack, fontSize: 10, letterSpacing: '0.15em' }}>
          WHOLESALE CATALOG · SHARMA BOUTIQUE
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-4 py-3 overflow-x-auto" style={{ background: palette.ivory, borderBottom: `1px solid rgba(26,26,26,0.05)` }}>
        <div className="flex gap-2" style={{ width: 'max-content' }}>
          {CATEGORIES.map((cat) => {
            const active = cat === category;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className="font-body uppercase whitespace-nowrap"
                style={{
                  color: active ? palette.ivory : palette.softBlack,
                  background: active ? palette.black : 'transparent',
                  border: active ? 'none' : `1px solid rgba(26,26,26,0.18)`,
                  padding: '7px 14px',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid — 2 cols on mobile */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-2 gap-3">
          {filtered.map((p) => (
            <ProductCard key={p.sku} product={p} showPrices={showPrices} />
          ))}
        </div>

        <div className="text-center py-8 font-display" style={{ color: '#998F7A', fontSize: 11, letterSpacing: '0.3em' }}>
          ── DREAM FORWARD ──
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  EXHIBITION TABLET VIEW
// ────────────────────────────────────────────────────────────
function ExhibitionTablet({ category, setCategory, showPrices, setShowPrices, filtered, cartCount }) {
  return (
    <div className="flex flex-col h-full" style={{ background: palette.ivory }}>
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-6 py-3.5"
        style={{ background: palette.black, color: palette.ivory }}
      >
        <div className="flex items-center gap-6">
          <div className="font-display" style={{ fontSize: 15, letterSpacing: '0.35em', fontWeight: 600 }}>
            DREVI · EXHIBITION
          </div>
          <div
            className="flex items-center gap-1.5 font-body cursor-pointer"
            style={{ fontSize: 10, letterSpacing: '0.15em', color: palette.champagne, border: `1px solid rgba(196,163,90,0.4)`, padding: '5px 11px' }}
          >
            SHARMA BOUTIQUE · PUNE
            <ChevronDown size={12} strokeWidth={1.8} />
          </div>
        </div>

        <div className="flex items-center gap-5">
          {/* Price toggle */}
          <button
            onClick={() => setShowPrices(!showPrices)}
            className="flex items-center gap-2 font-body uppercase"
            style={{
              color: showPrices ? palette.gold : '#9A9485',
              fontSize: 10,
              letterSpacing: '0.18em',
            }}
          >
            {showPrices ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
            Prices · {showPrices ? 'On' : 'Off'}
          </button>

          {/* Cart */}
          <div className="flex items-center gap-2 font-body uppercase" style={{ fontSize: 10, letterSpacing: '0.18em', color: palette.ivory }}>
            <div className="relative">
              <ShoppingBag size={16} strokeWidth={1.5} />
              {cartCount > 0 && (
                <div
                  className="absolute -top-1.5 -right-2 flex items-center justify-center font-body"
                  style={{ background: palette.gold, color: palette.black, fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: 8 }}
                >
                  {cartCount}
                </div>
              )}
            </div>
            Cart
          </div>

          {/* End session */}
          <button
            className="font-body uppercase"
            style={{
              color: palette.ivory,
              border: `1px solid rgba(255,255,255,0.3)`,
              padding: '6px 14px',
              fontSize: 10,
              letterSpacing: '0.2em',
            }}
          >
            End Session
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="px-6 py-3 flex items-center gap-4" style={{ background: palette.ivoryDeep, borderBottom: `1px solid rgba(26,26,26,0.06)` }}>
        <div className="flex items-center gap-2 font-body" style={{ color: palette.softBlack, fontSize: 11, letterSpacing: '0.15em' }}>
          <Search size={14} strokeWidth={1.7} />
          <span style={{ color: '#998F7A' }}>Search SKU, title…</span>
        </div>

        <div className="flex-1" style={{ borderLeft: `1px solid rgba(26,26,26,0.1)`, height: 18, marginLeft: 6 }} />

        <div className="flex gap-1.5 overflow-x-auto">
          {CATEGORIES.map((cat) => {
            const active = cat === category;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className="font-body uppercase whitespace-nowrap"
                style={{
                  color: active ? palette.ivory : palette.softBlack,
                  background: active ? palette.black : 'transparent',
                  border: active ? 'none' : `1px solid rgba(26,26,26,0.15)`,
                  padding: '6px 13px',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 font-body uppercase" style={{ color: palette.softBlack, fontSize: 10, letterSpacing: '0.15em' }}>
          <Filter size={13} strokeWidth={1.7} />
          Sort
          <ChevronDown size={12} strokeWidth={1.7} />
        </div>
      </div>

      {/* Grid — 3 cols on landscape tablet */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-3 gap-4">
          {filtered.map((p) => (
            <ProductCard key={p.sku} product={p} showPrices={showPrices} large />
          ))}
        </div>

        <div className="text-center py-8 font-display" style={{ color: '#998F7A', fontSize: 11, letterSpacing: '0.35em' }}>
          ── DREAM FORWARD · ROOT DEEP ──
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  ROOT
// ────────────────────────────────────────────────────────────
export default function WholesalePortalPrototype() {
  const [view, setView] = useState('buyer');         // 'buyer' | 'exhibition'
  const [category, setCategory] = useState('All');
  const [showPrices, setShowPrices] = useState(true);

  const filtered = category === 'All' ? PRODUCTS : PRODUCTS.filter((p) => p.category === category);
  const cartCount = 6;

  return (
    <div style={{ background: '#F5F1E8', minHeight: '100vh', padding: 24 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Cormorant+Garamond:wght@300;400;500;600&family=Montserrat:wght@300;400;500;600;700&display=swap');
        .font-display { font-family: 'Playfair Display', Georgia, serif; }
        .font-accent  { font-family: 'Cormorant Garamond', Georgia, serif; }
        .font-body    { font-family: 'Montserrat', system-ui, sans-serif; }
        * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
      `}</style>

      <div className="max-w-5xl mx-auto">
        {/* Header / chrome */}
        <div className="mb-6">
          <div className="font-display" style={{ color: palette.black, fontSize: 24, fontWeight: 600, letterSpacing: '0.02em' }}>
            Wholesale Portal · Catalog Screen
          </div>
          <div className="font-body mt-1" style={{ color: palette.softBlack, fontSize: 12, letterSpacing: '0.05em' }}>
            v2.2 design language preview · single screen, two views · all four stock states rendered
          </div>
        </div>

        {/* View toggle */}
        <div className="flex gap-2 mb-5">
          <button
            onClick={() => setView('buyer')}
            className="flex items-center gap-2 font-body uppercase transition-colors"
            style={{
              padding: '10px 16px',
              fontSize: 11,
              letterSpacing: '0.18em',
              color: view === 'buyer' ? palette.ivory : palette.black,
              background: view === 'buyer' ? palette.black : 'transparent',
              border: `1px solid ${palette.black}`,
            }}
          >
            <Smartphone size={13} strokeWidth={1.8} />
            Buyer · Mobile
          </button>
          <button
            onClick={() => setView('exhibition')}
            className="flex items-center gap-2 font-body uppercase transition-colors"
            style={{
              padding: '10px 16px',
              fontSize: 11,
              letterSpacing: '0.18em',
              color: view === 'exhibition' ? palette.ivory : palette.black,
              background: view === 'exhibition' ? palette.black : 'transparent',
              border: `1px solid ${palette.black}`,
            }}
          >
            <Tablet size={13} strokeWidth={1.8} />
            Exhibition · Tablet
          </button>
        </div>

        {/* Device frame */}
        {view === 'buyer' ? (
          <div className="flex justify-center">
            <div
              style={{
                width: 390,
                height: 780,
                borderRadius: 36,
                border: `10px solid ${palette.black}`,
                overflow: 'hidden',
                boxShadow: '0 30px 80px rgba(26,26,26,0.25)',
                background: palette.ivory,
              }}
            >
              <BuyerMobile category={category} setCategory={setCategory} showPrices={showPrices} filtered={filtered} cartCount={cartCount} />
            </div>
          </div>
        ) : (
          <div className="flex justify-center">
            <div
              style={{
                width: 1024,
                height: 720,
                borderRadius: 12,
                border: `10px solid ${palette.black}`,
                overflow: 'hidden',
                boxShadow: '0 30px 80px rgba(26,26,26,0.25)',
                background: palette.ivory,
                maxWidth: '100%',
              }}
            >
              <ExhibitionTablet
                category={category}
                setCategory={setCategory}
                showPrices={showPrices}
                setShowPrices={setShowPrices}
                filtered={filtered}
                cartCount={cartCount}
              />
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-3" style={{ background: palette.ivory, padding: 20, border: `1px solid rgba(26,26,26,0.08)` }}>
          <div>
            <StockPill product={{ stock: 7, restockable: true }} />
            <div className="font-body mt-2" style={{ fontSize: 10, color: palette.softBlack, lineHeight: 1.5 }}>
              Live inventory, replicable. The default for most Drevi pieces. No urgency cue.
            </div>
          </div>
          <div>
            <StockPill product={{ stock: 3, restockable: false }} />
            <div className="font-body mt-2" style={{ fontSize: 10, color: palette.softBlack, lineHeight: 1.5 }}>
              One-of-a-kind in stock. Exact count surfaced because scarcity is real.
            </div>
          </div>
          <div>
            <StockPill product={{ stock: 0, restockable: true, restock_days: 14 }} />
            <div className="font-body mt-2" style={{ fontSize: 10, color: palette.softBlack, lineHeight: 1.5 }}>
              Replicable but currently zero stock. Buyer sees timeline up front, not at confirmation.
            </div>
          </div>
          <div>
            <StockPill product={{ stock: 0, restockable: false }} />
            <div className="font-body mt-2" style={{ fontSize: 10, color: palette.softBlack, lineHeight: 1.5 }}>
              Stays in the grid as portfolio reference. Add to Cart disabled.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
