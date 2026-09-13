// Drevi's own registered particulars, as they appear on the GST registration
// certificate (Form GST REG-06, GSTIN 27BCXPD1099Q1ZM, approved 10 Jul 2026).
// Ansh supplied the certificate on 14 Sep 2026.
//
// A tax invoice has to carry the SUPPLIER's identity as well as the recipient's
// — until now the document carried neither, and the buyer-side work added only
// the recipient half. These are constants, not data: there is one registered
// entity and one principal place of business.
//
// LEGAL NAME vs TRADE NAME: the registration is a proprietorship in the name of
// Jyoti Devi Rakesh Kumar Saravgi, trading as Drevi Fashion. The invoice leads
// with the trade name because that is what a customer recognises, and carries
// the legal name beneath it because that is the registered person.

export const SUPPLIER = {
  tradeName: "Drevi Fashion",
  legalName: "Jyoti Devi Rakesh Kumar Saravgi",
  gstin: "27BCXPD1099Q1ZM",
  /** Registration type on the certificate — Regular, not Composition. */
  registrationType: "Regular",
  address: [
    "Shop No 11, Ground Floor, Sai Ganesh Sadan",
    "Senapati Bapat Marg, Pandurang Vakil Chawl",
    "Dadar West, Mumbai, Maharashtra 400028",
  ],
  /** First two digits of the GSTIN. Maharashtra. Kept alongside so a future
   *  place-of-supply / IGST split has the supplier state to compare against. */
  stateCode: "27",
  stateName: "Maharashtra",
  phone: "+91 88280 43555",
} as const;

/** One-line address, for places too tight for the stacked block. */
export const SUPPLIER_ADDRESS_LINE = SUPPLIER.address.join(", ");
