import express from "express";
import supabase from "../db.js";

const router = express.Router();

// Get price list for a customer
router.get("/:cus_id", async (req, res) => {
  try {
    const { cus_id } = req.params;

    const { data, error } = await supabase
      .from("exportcustomer_productair")
      .select(
        `
        id,
        common_name,
        scientific_name,
        image_url,
        category,
        size_range,
        purchasing_price,
        exfactoryprice,
        export_doc,
        transport_cost,
        loading_cost,
        airway_cost,
        forwardHandling_cost,
        multiplier,
        divisor,
        freight_type,
        fob_price,
        product_id,
        variant_id,
        freight_cost_45kg,
        freight_cost_100kg,
        freight_cost_300kg,
        freight_cost_500kg,
        cnf_45kg,
        cnf_100kg,
        cnf_300kg,
        cnf_500kg,
        freight_cost_20ft,
        cnf_20ft,
        freight_cost_40ft,
        cnf_40ft
      `,
      )
      .eq("cus_id", cus_id)
      .order("common_name");

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new custom price
router.post("/", async (req, res) => {
  try {
    const payload = req.body;

    const { data, error } = await supabase
      .from("exportcustomer_productair")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚠️ MUST be before PUT /:id and DELETE /:id — otherwise Express
// matches "recalculate" as the :id param and this route is never reached
router.post("/recalculate/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: cp, error: fetchError } = await supabase
      .from("exportcustomer_productair")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !cp)
      return res.status(404).json({ error: "Row not found" });

    console.log(
      `[recalculate] cp.multiplier=${cp.multiplier} cp.divisor=${cp.divisor} cp.cus_id=${cp.cus_id} cp.exfactoryprice=${cp.exfactoryprice}`,
    );

    const { data: usdRateData } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("date", { ascending: false })
      .limit(1)
      .single();

    const usdRate = parseFloat(usdRateData?.rate) || 304;
    console.log(`[recalculate] using usd_rate table: ${usdRate}`);

    const totalAdditionalUSD =
      (parseFloat(cp.export_doc) || 0) +
      (parseFloat(cp.transport_cost) || 0) +
      (parseFloat(cp.loading_cost) || 0) +
      (parseFloat(cp.airway_cost) || 0) +
      (parseFloat(cp.forwardHandling_cost) || 0);

    // fob_price stored as USD
    const fobInUSD =
      parseFloat(cp.exfactoryprice) / usdRate + totalAdditionalUSD;

    const updateData = { fob_price: fobInUSD }; // ← USD

    const { data: customerData } = await supabase
      .from("exportcustomersair")
      .select("country, airport_code")
      .eq("cus_id", cp.cus_id)
      .single();

    if (customerData) {
      let airRateQuery = supabase
        .from("freight_rates")
        .select("*")
        .eq("country", customerData.country)
        .order("date", { ascending: false })
        .limit(1);

      if (customerData.airport_code) {
        airRateQuery = supabase
          .from("freight_rates")
          .select("*")
          .eq("country", customerData.country)
          .eq("airport_code", customerData.airport_code)
          .order("date", { ascending: false })
          .limit(1);
      }

      const { data: airRates } = await airRateQuery;
      const airRate = airRates?.[0];

      const m = parseFloat(cp.multiplier) > 0 ? parseFloat(cp.multiplier) : 1;
      const d = parseFloat(cp.divisor) > 0 ? parseFloat(cp.divisor) : 1;

      console.log(
        `[recalculate] usdRate=${usdRate} m=${m} d=${d} fobInUSD=${fobInUSD}`,
      );

      if (airRate) {
        const fc45 = (m * parseFloat(airRate.rate_45kg)) / d;
        const fc100 = (m * parseFloat(airRate.rate_100kg)) / d;
        const fc300 = (m * parseFloat(airRate.rate_300kg)) / d;
        const fc500 = (m * parseFloat(airRate.rate_500kg)) / d;

        updateData.freight_cost_45kg = fc45;
        updateData.freight_cost_100kg = fc100;
        updateData.freight_cost_300kg = fc300;
        updateData.freight_cost_500kg = fc500;

        // CNF = FOB (USD) + Freight (USD) — pure addition
        updateData.cnf_45kg = fobInUSD + fc45;
        updateData.cnf_100kg = fobInUSD + fc100;
        updateData.cnf_300kg = fobInUSD + fc300;
        updateData.cnf_500kg = fobInUSD + fc500;

        console.log(
          `[recalculate] ✅ cnf_45kg=${updateData.cnf_45kg} cnf_100kg=${updateData.cnf_100kg}`,
        );
      } else {
        console.log(
          `[recalculate] ⚠️ No air rate found for country=${customerData.country}`,
        );
      }
    } else {
      console.log(`[recalculate] ⚠️ No customer found for cus_id=${cp.cus_id}`);
    }

    const { data, error: updateError } = await supabase
      .from("exportcustomer_productair")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json(data);
  } catch (err) {
    console.error("Error in recalculate:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update existing price
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body;

    const { data, error } = await supabase
      .from("exportcustomer_productair")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete price
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("exportcustomer_productair")
      .delete()
      .eq("id", id);

    if (error) throw error;
    res.json({ message: "Price deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
