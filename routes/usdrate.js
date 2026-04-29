import express from "express";
import supabase from "../db.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER 1: Update usdrate + recalculate exfactoryprice on all variants
//           in the unified "products" table (export_sea and export_air types)
// ─────────────────────────────────────────────────────────────────────────────
const updateVariantUsdRates = async (newUsdRate) => {
  console.log(
    `[Variant USD Update] Updating all variants to rate: ${newUsdRate}`,
  );

  try {
    // Only fetch products that have export types
    const { data: products, error: fetchError } = await supabase
      .from("products")
      .select("id, variants, product_types")
      .or("product_types.cs.{export_sea},product_types.cs.{export_air}");

    if (fetchError) throw fetchError;
    if (!products || products.length === 0) {
      console.log("[Variant USD Update] No export products found");
      return { totalUpdated: 0, totalErrors: 0 };
    }

    let totalUpdated = 0;
    let totalErrors = 0;

    for (const product of products) {
      if (
        !product.variants ||
        !Array.isArray(product.variants) ||
        product.variants.length === 0
      )
        continue;

      try {
        const updatedVariants = product.variants.map((variant) => {
          const purchasePrice = parseFloat(variant.purchasing_price) || 0;
          const jcFobUSD = parseFloat(variant.jc_fob) || 0;
          const packingCostUSD = parseFloat(variant.packing_cost) || 0;
          const labourUSD = parseFloat(variant.labour_overhead) || 0;
          const profitUSD =
            parseFloat(variant.profit_usd ?? variant.profit) || 0;

          let newExFactory = variant.exfactoryprice; // default: keep existing

          if (jcFobUSD > 0) {
            // JC FOB model: exfactory = (jc_fob + profit_usd + packing + labour) * rate
            newExFactory = parseFloat(
              (
                (jcFobUSD + profitUSD + packingCostUSD + labourUSD) *
                newUsdRate
              ).toFixed(2),
            );
          } else if (purchasePrice > 0) {
            // Purchase price model: exfactory = purchasing_price + (labour + packing + profit_usd) * rate
            newExFactory = parseFloat(
              (
                purchasePrice +
                (labourUSD + packingCostUSD + profitUSD) * newUsdRate
              ).toFixed(2),
            );
          }

          // Also recalc profit_lkr from profit_usd if stored
          const newProfitLkr =
            profitUSD > 0
              ? parseFloat((profitUSD * newUsdRate).toFixed(2))
              : parseFloat(variant.profit_lkr) || 0;

          return {
            ...variant,
            usdrate: newUsdRate,
            exfactoryprice: newExFactory,
            profit_lkr: newProfitLkr,
          };
        });

        const { error: updateError } = await supabase
          .from("products")
          .update({ variants: updatedVariants })
          .eq("id", product.id);

        if (updateError) {
          console.error(
            `[Variant USD Update] Error on product ${product.id}:`,
            updateError,
          );
          totalErrors++;
        } else {
          totalUpdated++;
        }
      } catch (err) {
        console.error(
          `[Variant USD Update] Exception on product ${product.id}:`,
          err,
        );
        totalErrors++;
      }
    }

    console.log(
      `[Variant USD Update] Done — ${totalUpdated} products updated, ${totalErrors} errors`,
    );
    return { totalUpdated, totalErrors };
  } catch (err) {
    console.error("[Variant USD Update] Fatal error:", err);
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER 2: Recalculate FOB (USD) + CNF in exportcustomer_product (sea)
//           fob_price is stored as USD:
//           fob_usd = exfactoryprice_lkr / newUsdRate + totalHandlingUSD
// ─────────────────────────────────────────────────────────────────────────────
const recalculateCustomerPrices = async (newUsdRate) => {
  console.log(`[Customer Price Recalc] Starting with USD rate: ${newUsdRate}`);

  const results = {
    sea: { updated: 0, errors: 0 },
    air: { updated: 0, errors: 0 },
  };

  // ── SEA customer products ──
  try {
    const { data: seaProducts, error } = await supabase
      .from("exportcustomer_product")
      .select("*");

    if (error) throw error;

    for (const cp of seaProducts || []) {
      try {
        const exf = parseFloat(cp.exfactoryprice) || 0;
        const export_doc = parseFloat(cp.export_doc) || 0;
        const transport_cost = parseFloat(cp.transport_cost) || 0;
        const loading_cost = parseFloat(cp.loading_cost) || 0;
        const airway_cost = parseFloat(cp.airway_cost) || 0;
        const fwdHandling = parseFloat(cp.forwardHandling_cost) || 0;

        const totalHandlingUSD =
          export_doc +
          transport_cost +
          loading_cost +
          airway_cost +
          fwdHandling;

        // fob_price stored as USD
        const fobUSD = exf / newUsdRate + totalHandlingUSD;

        const updates = { fob_price: parseFloat(fobUSD.toFixed(4)) };

        if (cp.freight_type === "sea") {
          const fc20 = parseFloat(cp.freight_cost_20ft) || 0;
          const fc40 = parseFloat(cp.freight_cost_40ft) || 0;
          updates.cnf_20ft = parseFloat((fobUSD + fc20).toFixed(2));
          updates.cnf_40ft = parseFloat((fobUSD + fc40).toFixed(2));
        } else if (cp.freight_type === "air") {
          const fc45 = parseFloat(cp.freight_cost_45kg) || 0;
          const fc100 = parseFloat(cp.freight_cost_100kg) || 0;
          const fc300 = parseFloat(cp.freight_cost_300kg) || 0;
          const fc500 = parseFloat(cp.freight_cost_500kg) || 0;
          updates.cnf_45kg = parseFloat((fobUSD + fc45).toFixed(2));
          updates.cnf_100kg = parseFloat((fobUSD + fc100).toFixed(2));
          updates.cnf_300kg = parseFloat((fobUSD + fc300).toFixed(2));
          updates.cnf_500kg = parseFloat((fobUSD + fc500).toFixed(2));
        }

        const { error: upErr } = await supabase
          .from("exportcustomer_product")
          .update(updates)
          .eq("id", cp.id);

        if (upErr) {
          console.error(`[Sea Recalc] Error on ${cp.id}:`, upErr);
          results.sea.errors++;
        } else results.sea.updated++;
      } catch (e) {
        console.error(`[Sea Recalc] Exception on ${cp.id}:`, e);
        results.sea.errors++;
      }
    }
  } catch (err) {
    console.error("[Sea Recalc] Fatal:", err);
  }

  // ── AIR customer products ──
  try {
    const { data: airProducts, error } = await supabase
      .from("exportcustomer_productair")
      .select("*");

    if (error) throw error;

    for (const cp of airProducts || []) {
      try {
        const exf = parseFloat(cp.exfactoryprice) || 0;
        const export_doc = parseFloat(cp.export_doc) || 0;
        const transport_cost = parseFloat(cp.transport_cost) || 0;
        const loading_cost = parseFloat(cp.loading_cost) || 0;
        const airway_cost = parseFloat(cp.airway_cost) || 0;
        const fwdHandling = parseFloat(cp.forwardHandling_cost) || 0;

        const totalHandlingUSD =
          export_doc +
          transport_cost +
          loading_cost +
          airway_cost +
          fwdHandling;

        // fob_price stored as USD
        const fobUSD = exf / newUsdRate + totalHandlingUSD;

        const updates = { fob_price: parseFloat(fobUSD.toFixed(4)) };

        if (cp.freight_type === "air") {
          const fc45 = parseFloat(cp.freight_cost_45kg) || 0;
          const fc100 = parseFloat(cp.freight_cost_100kg) || 0;
          const fc300 = parseFloat(cp.freight_cost_300kg) || 0;
          const fc500 = parseFloat(cp.freight_cost_500kg) || 0;
          updates.cnf_45kg = parseFloat((fobUSD + fc45).toFixed(2));
          updates.cnf_100kg = parseFloat((fobUSD + fc100).toFixed(2));
          updates.cnf_300kg = parseFloat((fobUSD + fc300).toFixed(2));
          updates.cnf_500kg = parseFloat((fobUSD + fc500).toFixed(2));
        } else if (cp.freight_type === "sea") {
          const fc20 = parseFloat(cp.freight_cost_20ft) || 0;
          const fc40 = parseFloat(cp.freight_cost_40ft) || 0;
          updates.cnf_20ft = parseFloat((fobUSD + fc20).toFixed(2));
          updates.cnf_40ft = parseFloat((fobUSD + fc40).toFixed(2));
        }

        const { error: upErr } = await supabase
          .from("exportcustomer_productair")
          .update(updates)
          .eq("id", cp.id);

        if (upErr) {
          console.error(`[Air Recalc] Error on ${cp.id}:`, upErr);
          results.air.errors++;
        } else results.air.updated++;
      } catch (e) {
        console.error(`[Air Recalc] Exception on ${cp.id}:`, e);
        results.air.errors++;
      }
    }
  } catch (err) {
    console.error("[Air Recalc] Fatal:", err);
  }

  console.log(
    `[Customer Price Recalc] Done — sea: ${results.sea.updated} updated, air: ${results.air.updated} updated`,
  );
  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Combined trigger
// ─────────────────────────────────────────────────────────────────────────────
const onRateChanged = async (newUsdRate) => {
  const [variantResult, customerResult] = await Promise.allSettled([
    updateVariantUsdRates(newUsdRate),
    recalculateCustomerPrices(newUsdRate),
  ]);

  return {
    variantUpdates:
      variantResult.status === "fulfilled"
        ? variantResult.value
        : { error: variantResult.reason?.message },
    customerPriceUpdates:
      customerResult.status === "fulfilled"
        ? customerResult.value
        : { error: customerResult.reason?.message },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { data: currentRate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ message: "No USD rate found" });
      throw error;
    }

    res.json({
      rate: currentRate.rate,
      date: currentRate.date,
      updated_at: currentRate.updated_at,
    });
  } catch (err) {
    console.error("Error fetching USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate/history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const { data: history, error } = await supabase
      .from("usd_rates")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(history);
  } catch (err) {
    console.error("Error fetching USD rate history:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate/date/:date
// ─────────────────────────────────────────────────────────────────────────────
router.get("/date/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const { data: rate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .eq("date", date)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ message: "No rate found for this date" });
      throw error;
    }
    res.json(rate);
  } catch (err) {
    console.error("Error fetching USD rate by date:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/usd-rate — add new rate + trigger full recalculation
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { rate, date } = req.body;
    if (!rate || parseFloat(rate) <= 0)
      return res
        .status(400)
        .json({ message: "A valid rate greater than 0 is required" });

    const newRate = parseFloat(rate);

    const { data: newRateData, error: insertError } = await supabase
      .from("usd_rates")
      .insert({
        rate: newRate,
        date: date || new Date().toISOString().split("T")[0],
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const recalcResult = await onRateChanged(newRate);

    res.status(201).json({
      message: "USD rate saved — all variants and customer prices recalculated",
      rate: newRateData.rate,
      date: newRateData.date,
      updated_at: newRateData.updated_at,
      recalculation: recalcResult,
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/usd-rate/:id — edit rate + recalculate if it's the latest
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rate, date } = req.body;
    if (!rate || parseFloat(rate) <= 0)
      return res
        .status(400)
        .json({ message: "A valid rate greater than 0 is required" });

    const newRate = parseFloat(rate);

    const { data: updatedRate, error: updateError } = await supabase
      .from("usd_rates")
      .update({ rate: newRate, date, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    const { data: latestRate } = await supabase
      .from("usd_rates")
      .select("id")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    let recalcResult = {
      skipped: true,
      reason: "Not the latest rate entry — prices unchanged",
    };
    if (latestRate && String(latestRate.id) === String(id)) {
      recalcResult = await onRateChanged(newRate);
    }

    res.json({
      message: recalcResult.skipped
        ? "Rate entry updated (not the latest — prices not recalculated)"
        : "Rate updated — all variants and customer prices recalculated",
      rate: updatedRate.rate,
      date: updatedRate.date,
      updated_at: updatedRate.updated_at,
      recalculation: recalcResult,
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/usd-rate/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("usd_rates").delete().eq("id", id);
    if (error) throw error;
    res.json({ message: "Rate entry deleted successfully" });
  } catch (err) {
    console.error("Error deleting USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/usd-rate/recalculate — manual trigger
// ─────────────────────────────────────────────────────────────────────────────
router.post("/recalculate", async (req, res) => {
  try {
    const { data: latestRate, error } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !latestRate)
      return res
        .status(404)
        .json({ message: "No USD rate found to recalculate with" });

    const result = await onRateChanged(parseFloat(latestRate.rate));

    res.json({
      message: "Manual recalculation complete",
      rateUsed: latestRate.rate,
      ...result,
    });
  } catch (err) {
    console.error("Error in manual recalculation:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
