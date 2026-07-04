// =========================================================
// VESTI CODEX — v0.1 (extracted from api/stylist.js, Jul 2026)
//
// This file IS the styling methodology: §5.0 city overlays and
// §5 occasion entries. Source of truth: /Vesti_Methodology_v0.1.md.
// Update HERE (not in stylist.js) when the methodology changes,
// and bump the version below.
//
// Priority rule (§5.0 "How to apply"): climate (fabric weight,
// layering) wins; everything else (color, register) defers to
// the §5 occasion entry.
// =========================================================

export const CODEX_VERSION = "0.1";

export const CITY_OVERLAYS = {
  Beirut: `Beirut (codex baseline):
- Climate: Mediterranean. Hot/humid summer (Jun–Sep), mild wet winter (Dec–Feb). Coastal humidity matters; mountain venues drop 8–12°C from city.
- Light: Levantine sun is brighter and warmer than Northern European reference photos — apply "one shade darker" correction.
- Dress register: warm/social rather than buttoned-up. Open-collar shirt with soft jacket is acceptable across most "smart" occasions.
- Black-shoe defaults read normally; brown shoes the wedding-guest signal.`,

  Dubai: `Dubai overlay (apply ON TOP of Beirut baseline):
- Climate: desert. Outdoor anything May–Oct is heat-prohibitive — assume air-conditioned interiors as the default venue type. AC-first weight rule: around 250 g/m² year-round indoors, drop under 250 only for genuine outdoor day events. This OVERRIDES the "summer = lighter" rule.
- Light: harsh, high-UV. Stay one shade darker than Beirut defaults; off-white and stone palettes lift better than pure white in daytime photos.
- Dress register: more formal than Beirut for equivalent occasions. Business meetings default to suit + tie even where Beirut would accept a soft jacket.
- Local rules: respect modesty conventions in mixed/family settings. Linen is fine but linen jackets to client meetings are not.
- Brand availability: Joseph Eid bespoke ships to UAE; Beirut-only retail references should be substituted with Dubai equivalents.`,

  Riyadh: `Riyadh overlay (apply ON TOP of Beirut baseline):
- Climate: desert, drier and hotter swings than Dubai. Outdoor anything May–Sep is heat-prohibitive; even Oct–Apr afternoons run hot. Default to AC-interior venues year-round. AC-first weight rule: 250–280 g/m² indoors, drop under 250 only for genuine outdoor early-morning or late-evening events. This OVERRIDES the "summer = lighter" rule.
- Light: high UV, very harsh. Stay one shade darker than Beirut defaults; off-white and stone palettes lift better than pure white in daytime photos.
- Dress register: MORE formal and conservative than Dubai for equivalent occasions. Full suit + tie is the default for business and most formal social settings. Modesty conventions are stronger — long sleeves, tailored (not skinny) trousers, no exposed ankles in formal contexts.
- Local rules: thobe is the dominant local male formalwear. Lebanese guests can wear a Western suit for any business context; thobe is optional only if Gulf-regular and own one well. Avoid linen for business meetings. Restraint in color and pattern reads as respect.
- Brand availability: Joseph Eid has no KSA retail presence; rely on Beirut bespoke shipped or remote fit.`,

  "New York": `New York overlay (apply ON TOP of Beirut baseline):
- Climate: four-season. Wide swing — humid summer (Jun–Aug, Beirut-comparable), genuine cold winter (Dec–Feb, Beirut never gets there). Outerwear becomes load-bearing Nov–Mar. Layering (overshirt over shirt, knit under blazer) is the default move where Beirut would skip the extra layer.
- Light: cooler, more diffuse than Levantine sun. The "one shade darker" correction does NOT apply — colors render closer to catalog. Mid grey reads as mid grey, not washed-out.
- Dress register: industry-dependent. Finance/legal/consulting still default to suit + tie; tech/creative is jacket-optional even at senior levels. The codex's "soft jacket + open collar" Beirut default lands well in NY creative contexts but reads under-dressed in NY finance.
- Cultural occasions: Lebanese diaspora occasions follow Beirut entries below. Mainstream American occasions (Thanksgiving, summer Hamptons wedding, business-casual Friday) are NOT in the codex yet — flag this gap to the user rather than improvise.
- Brand availability: Joseph Eid does not have NY presence; rely on remote-fit Beirut bespoke or substitute with US-equivalent menswear (Drakes, Hertling, Alden).`
};

// Priority rule from §5.0 "How to apply":
// Climate (fabric weight, layering) wins; everything else (color, register)
// defers to the §5 entry. Reflected in the prompt below.

export const CODEX_OCCASIONS = `OCCASION ENTRIES (Beirut-baseline defaults):

Lebanese summer mountain wedding (Faraya, Broummana, Ehden — Jun–Sep, outdoor evening):
Light-to-mid grey suit, fresco/open-weave wool under 250 g/m². White or pale blue shirt. Pastel or muted tie. Brown or burgundy oxfords/derbies, matched belt. No three-piece. Single pleat trouser, no break or quarter break.

Beirut indoor wedding (hotel ballroom, AC, year-round, evening):
Navy suit, mid-weight wool ~250 g/m². White shirt. Burgundy/deep green/navy-and-silver tie. Black oxfords, matched black belt. Three-piece acceptable here only in summer (aggressive AC). White pocket square folded flat.

Khaleeji wedding (Saudi/Emirati/Qatari host, Lebanese guest):
Path A: charcoal or midnight navy three-piece, mid-to-heavy wool, white shirt, dark tie, black oxfords. Path B (only if Gulf-regular and own a thobe and host welcomes traditional dress): white summer-weight thobe, plain ghutra, no agal unless local custom calls for it. Better a sharp Western suit than a poorly fitted thobe.

Majlis (Gulf evening reception — Lebanese guest):
Thobe if Gulf-regular and own one. Otherwise: charcoal or dark grey suit, white shirt, no tie, black or dark brown loafers. Avoid notch lapels with a tieless shirt.

Dubai/Riyadh business summer:
Mid grey or navy suit in tropical wool or fresco, under 250 g/m². White or pale blue shirt. Tie required for first meetings, optional for follow-ups depending on industry. Black oxfords. No three-piece. NO linen jackets to client meetings.

Funeral (not family of the deceased):
Dark charcoal grey or midnight navy suit, white shirt, plain black tie, black oxfords, black belt. White pocket square optional.
Funeral (family of the deceased or pallbearer): Full black suit, white shirt, black tie, black shoes. Only context where all-black is correct.

Casual Friday (Mar Mikhael, Hamra, Gemmayze):
Dark wash jeans or chinos in stone/olive, plain white or pale tee/polo, optional unstructured navy or olive blazer, white minimalist sneakers (Common Projects Achilles, Axel Arigato Clean 90, Zegna Triple Stitch) or brown loafers. No suit, no tie. White sneakers means MINIMALIST leather sneakers, never athletic silhouettes.

Iftar (Ramadan evening meal):
Lebanon (host's home or Beirut restaurant): dark navy or charcoal soft jacket, white or pale shirt open at collar, dark trousers, brown loafers. No tie. Warm/social register.
UAE/Saudi (host's home, hotel iftar tent, business iftar): full suit (charcoal or midnight navy, mid-weight wool), white shirt, restrained tie (navy/burgundy/deep green), black oxfords. Err on more formal.

Business travel (multi-day, mixed climate):
Default kit: one navy suit (mid weight, 250 g/m²), one mid grey trouser, two white shirts, one pale blue shirt, one navy tie, one burgundy tie, one pair black oxfords, one pair brown loafers, belts to match. Add a single sport coat if the trip includes a casual evening.

Birthday dinner (adult, restaurant):
Dark trouser, soft jacket (navy/charcoal/olive), open-collar shirt, no tie, loafers or derbies. Upscale venue (Em Sherif, Liza, Indigo on the Roof) → add tie + switch to oxfords.

Engagement party (Lebanese — Christian or Muslim, evening):
Navy suit (~250 g/m²), white or pale blue shirt, restrained tie (burgundy/dark green/navy with subtle pattern), black or dark brown oxfords. NO three-piece — engagement is one register below the wedding itself. White pocket square folded flat.
Variation summer outdoor mountain estate: mid grey replaces navy, tan or burgundy loafers replace black oxfords.

Baptism — as godfather (parrain):
Charcoal grey two-piece suit (mid-to-heavy wool), white shirt, restrained tie (silver-grey/pale blue/burgundy), black oxfords. White pocket square. Three-piece optional upgrade.
Baptism — as guest: navy or mid grey two-piece, white or pale blue shirt, restrained tie, brown or black oxfords.

University graduation — graduate: navy suit, white shirt, navy or burgundy tie, black oxfords.
University graduation — parent of graduate: charcoal suit, white shirt, dark tie. Slightly more formal than the graduate. Pocket square appropriate.

Condolences (azza / حضور العزاء):
Dark grey or charcoal trouser, dark grey or navy soft jacket (unstructured or lightly structured), white shirt, no tie, black or dark brown oxfords. NO pocket square. NO watch beyond a plain leather strap. Distinct from the funeral itself — full suit-and-tie reads as still-funeral; jeans-and-shirt reads as not taking the visit seriously.

Name day (يوم العيد — Christian saint's day):
Navy or charcoal soft jacket, white or pale shirt, no tie unless host's family is older/formal, dark trousers, brown loafers. Smart-casual register.

Summer beach club lunch (Edde Sands, La Plage, Lazy B, Sporting):
Linen or cotton trouser in white/stone/navy; linen short-sleeve shirt or fine-knit polo in white/pale blue/sage; minimalist white leather sneakers; tortoise sunglasses. Optional unstructured linen jacket in stone or navy if dinner extends. Sneakers are the natural choice for adult men of any age in this context.

Christmas dinner at family home:
Dark trouser (chinos in stone/navy/charcoal), button-down shirt (white/pale blue/subtle pattern) or fine-knit polo, optional unstructured blazer (navy/charcoal) if host's family older/traditional. Loafers or clean leather sneakers. No tie required.
Variation older/traditional families (grandparents hosting): lift to navy soft jacket + tie.

Easter Mass and family lunch (Catholic or Orthodox):
Chinos or dark trousers, button-down shirt or fine knit polo, optional blazer for the Mass itself. Brown or dark dress shoes (loafers acceptable). Mass register one notch above Christmas dinner due to religious context. Lent-color rule (no bright colors during 40 days before Easter) is no longer widely observed — do NOT enforce by default.

Hospital visit:
Dark trouser (charcoal/grey/navy), soft button-down shirt (white or pale), no tie, navy or grey blazer if visit is to an older relative or someone in private rooms. Brown loafers or dark dress shoes.

Casual errands:
Plain or lightly graphic tee (formality 1-2) in white, grey, or charcoal; dark-wash jeans or stone/olive chinos; minimalist white leather sneakers. No jacket, no collar required. The most relaxed occasion in the codex — a clean tee is the correct default here, not a fallback.

Weekend brunch:
A notch above errands: fine-knit polo or short-sleeve linen shirt over chinos in stone/olive, or a crisp plain tee under an unstructured overshirt. Minimalist sneakers or brown loafers. Relaxed but considered — appropriate for being seen socially. No tie, jacket optional.`;
