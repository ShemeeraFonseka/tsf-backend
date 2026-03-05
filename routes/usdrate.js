import express from "express";
import supabase from "../db.js";

const router = express.Router();

// Helper function to recalculate all product prices with new USD rate
const recalculateProductPrices = async (newUsdRate) => {
  try {
    console.log(`Starting recalculation with new USD rate: ${newUsdRate}`);

    const { data: products, error: fetchError } = await supabase
      .from("exportcustomer_product")
      .select("*");

    if (fetchError) throw fetchError;

    if (!products || products.length === 0) {
      console.log("No products to recalculate");
      return { updated: 0, errors: 0 };
    }

    let updated = 0;
    let errors = 0;

    for (const product of products) {
      try {
        const export_doc = parseFloat(product.export_doc) || 0;
        const transport_cost = parseFloat(product.transport_cost) || 0;
        const loading_cost = parseFloat(product.loading_cost) || 0;
        const airway_cost = parseFloat(product.airway_cost) || 0;
        const forwardHandling_cost =
          parseFloat(product.forwardHandling_cost) || 0;
        const exfactoryprice = parseFloat(product.exfactoryprice) || 0;

        // Total additional costs (USD) → convert to LKR with NEW rate
        const totalCostsUSD =
          export_doc +
          transport_cost +
          loading_cost +
          airway_cost +
          forwardHandling_cost;
        const totalCostsLKR = totalCostsUSD * newUsdRate;

        // New FOB in LKR
        const newFobPrice = exfactoryprice + totalCostsLKR;

        // FOB in USD using new rate
        const fobInUSD = newFobPrice / newUsdRate;

        const updates = {
          fob_price: parseFloat(newFobPrice.toFixed(2)),
        };

        if (product.freight_type === "air") {
          // Recalculate all 4 CNF tiers: cnf = fob_in_usd + freight_cost_for_tier
          const fc45 = parseFloat(product.freight_cost_45kg) || 0;
          const fc100 = parseFloat(product.freight_cost_100kg) || 0;
          const fc300 = parseFloat(product.freight_cost_300kg) || 0;
          const fc500 = parseFloat(product.freight_cost_500kg) || 0;

          updates.cnf_45kg = parseFloat((fobInUSD + fc45).toFixed(2));
          updates.cnf_100kg = parseFloat((fobInUSD + fc100).toFixed(2));
          updates.cnf_300kg = parseFloat((fobInUSD + fc300).toFixed(2));
          updates.cnf_500kg = parseFloat((fobInUSD + fc500).toFixed(2));

          console.log(
            `Product ${product.id} (air): FOB Rs.${newFobPrice.toFixed(2)}, CNF 45kg $${updates.cnf_45kg}`,
          );
        } else if (product.freight_type === "sea") {
          // Recalculate both container CNFs: cnf = fob_in_usd + freight_per_kilo
          const fc20 = parseFloat(product.freight_cost_20ft) || 0;
          const fc40 = parseFloat(product.freight_cost_40ft) || 0;

          updates.cnf_20ft = parseFloat((fobInUSD + fc20).toFixed(2));
          updates.cnf_40ft = parseFloat((fobInUSD + fc40).toFixed(2));

          console.log(
            `Product ${product.id} (sea): FOB Rs.${newFobPrice.toFixed(2)}, CNF 20ft $${updates.cnf_20ft}, CNF 40ft $${updates.cnf_40ft}`,
          );
        }

        const { error: updateError } = await supabase
          .from("exportcustomer_product")
          .update(updates)
          .eq("id", product.id);

        if (updateError) {
          console.error(`Error updating product ${product.id}:`, updateError);
          errors++;
        } else {
          updated++;
        }
      } catch (err) {
        console.error(`Error processing product ${product.id}:`, err);
        errors++;
      }
    }

    console.log(`Recalculation complete: ${updated} updated, ${errors} errors`);
    return { updated, errors };
  } catch (err) {
    console.error("Error in recalculateProductPrices:", err);
    throw err;
  }
};

// GET current USD rate (most recent)
router.get("/", async (req, res) => {
  try {
    const { data: currentRate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ message: "No USD rate found" });
      }
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

// GET rate history
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

// POST - Add new USD rate and recalculate all products
router.post("/", async (req, res) => {
  try {
    const { rate, date } = req.body;

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: "Valid rate is required" });
    }

    const newRate = parseFloat(rate);

    const { data: newRateData, error } = await supabase
      .from("usd_rates")
      .insert({
        rate: newRate,
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    const recalcResult = await recalculateProductPrices(newRate);

    res.status(201).json({
      message: "USD rate updated successfully",
      rate: newRateData.rate,
      date: newRateData.date,
      updated_at: newRateData.updated_at,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors,
      },
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// DELETE - Remove a specific rate entry
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

// GET rate for a specific date
router.get("/date/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const searchDate = new Date(date);
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString();
    const endOfDay = new Date(
      searchDate.setHours(23, 59, 59, 999),
    ).toISOString();

    const { data: rate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .gte("date", startOfDay)
      .lte("date", endOfDay)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ message: "No rate found for this date" });
      }
      throw error;
    }
    res.json(rate);
  } catch (err) {
    console.error("Error fetching rate by date:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// PUT - Update an existing rate entry and recalculate products
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rate, date } = req.body;

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: "Valid rate is required" });
    }

    const newRate = parseFloat(rate);

    const { data: updatedRate, error } = await supabase
      .from("usd_rates")
      .update({
        rate: newRate,
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    const recalcResult = await recalculateProductPrices(newRate);

    res.json({
      message: "USD rate updated successfully",
      rate: updatedRate.rate,
      date: updatedRate.date,
      updated_at: updatedRate.updated_at,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors,
      },
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
