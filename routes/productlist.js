import express from "express";
import supabase from "../db.js";
import multer from "multer";
import path from "path";

const router = express.Router();

// Configure multer for memory storage (we'll upload to Supabase Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// GET all products with their variants
router.get("/", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .order("common_name");

    if (error) throw error;

    // Sort products by their lowest variant price
    const sortedProducts = products
      .map((product) => {
        // Sort variants within each product by purchasing_price
        if (product.variants && product.variants.length > 0) {
          product.variants.sort((a, b) => {
            return (
              parseFloat(a.purchasing_price) - parseFloat(b.purchasing_price)
            );
          });
        }
        return product;
      })
      .sort((a, b) => {
        // Sort products by their lowest variant price
        const priceA =
          a.variants && a.variants.length > 0
            ? Math.min(...a.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;

        const priceB =
          b.variants && b.variants.length > 0
            ? Math.min(...b.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;

        return priceA - priceB;
      });

    res.json(sortedProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// GET single product by ID
router.get("/:id", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Product not found" });
      }
      throw error;
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new product with variants
router.post("/upload", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    category,
    description,
    species_type,
    variants,
  } = req.body;
  let image_url = null;

  try {
    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);

      image_url = publicUrl;
    }

    // Parse variants if it's a string
    const variantsData =
      typeof variants === "string" ? JSON.parse(variants) : variants || [];

    const { data, error } = await supabase
      .from("products")
      .insert({
        common_name,
        scientific_name,
        category,
        description,
        species_type,
        image_url,
        variants: variantsData,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT - Update product with variants
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    description,
    category,
    species_type,
    existing_image_url,
    variants,
  } = req.body;
  let image_url = existing_image_url;

  try {
    // Get the current product to check for purchase price changes
    const { data: currentProduct, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", req.params.id)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({ error: "Product not found" });
      }
      throw fetchError;
    }

    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);

      image_url = publicUrl;
    }

    // Parse variants if it's a string
    const variantsData =
      typeof variants === "string" ? JSON.parse(variants) : variants || [];

    // Update product
    const { error: updateError } = await supabase
      .from("products")
      .update({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        variants: variantsData,
      })
      .eq("id", req.params.id);

    if (updateError) throw updateError;

    // Check if purchase prices have changed and update customer prices
    if (currentProduct && currentProduct.variants) {
      const oldVariants = currentProduct.variants;
      const newVariants = variantsData;

      // Find variants where purchase price changed
      const priceChanges = [];

      newVariants.forEach((newVariant) => {
        const oldVariant = oldVariants.find((v) => v.id === newVariant.id);
        if (
          oldVariant &&
          oldVariant.purchasing_price !== newVariant.purchasing_price
        ) {
          priceChanges.push({
            variantId: newVariant.id,
            oldPrice: oldVariant.purchasing_price,
            newPrice: newVariant.purchasing_price,
          });
        }
      });

      // Update customer prices for affected variants
      if (priceChanges.length > 0) {
        for (const change of priceChanges) {
          // Get all customer prices for this product/variant
          const { data: customerPrices, error: fetchPricesError } =
            await supabase
              .from("customer_product")
              .select("*")
              .eq("product_id", req.params.id)
              .eq("variant_id", change.variantId);

          if (fetchPricesError) {
            console.error("Error fetching customer prices:", fetchPricesError);
            continue;
          }

          // Update each customer price
          for (const customerPrice of customerPrices) {
            const priceDifference = change.newPrice - change.oldPrice;

            // Recalculate based on existing margin or margin percentage
            let newSellingPrice;
            let newMargin;
            let newMarginPercentage;

            if (customerPrice.margin_percentage > 0) {
              // Recalculate using margin percentage
              newMargin =
                (change.newPrice * customerPrice.margin_percentage) / 100;
              newSellingPrice = change.newPrice + newMargin;
              newMarginPercentage = customerPrice.margin_percentage;
            } else if (customerPrice.margin > 0) {
              // Keep same margin amount
              newMargin = customerPrice.margin;
              newSellingPrice = change.newPrice + newMargin;
              newMarginPercentage = (newMargin / newSellingPrice) * 100;
            } else {
              // Just add the price difference
              newSellingPrice = customerPrice.selling_price + priceDifference;
              newMargin = customerPrice.margin;
              newMarginPercentage = customerPrice.margin_percentage;
            }

            const { error: updatePriceError } = await supabase
              .from("customer_product")
              .update({
                purchasing_price: change.newPrice,
                selling_price: newSellingPrice,
                margin: newMargin,
                margin_percentage: newMarginPercentage,
              })
              .eq("id", customerPrice.id);

            if (updatePriceError) {
              console.error("Error updating customer price:", updatePriceError);
            }
          }
        }
      }
    }

    // Fetch and return updated product
    const { data: updatedProduct, error: fetchUpdatedError } = await supabase
      .from("products")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (fetchUpdatedError) throw fetchUpdatedError;

    res.json(updatedProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// ============== VARIANT OPERATIONS (within same product record) ==============

// GET all variants for a product
router.get("/:productId/variants", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("variants")
      .eq("id", req.params.productId)
      .single();

    if (error) throw error;

    res.json(product.variants || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new variant to a product
router.post("/:productId/variants", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    profit,
    profit_margin_percentage,
    selling_price,
  } = req.body;
  const { productId } = req.params;

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    // Calculate missing values
    let calculatedProfit = profit;
    let calculatedMarginPercentage = profit_margin_percentage;
    let calculatedSellingPrice = selling_price;

    if (selling_price && !profit && !profit_margin_percentage) {
      // If only selling price is provided, calculate profit and margin
      calculatedProfit =
        parseFloat(selling_price) - parseFloat(purchasing_price);
      calculatedMarginPercentage =
        (calculatedProfit / parseFloat(selling_price)) * 100;
    } else if (profit && !selling_price) {
      // If profit is provided, calculate selling price and margin percentage
      calculatedSellingPrice =
        parseFloat(purchasing_price) + parseFloat(profit);
      calculatedMarginPercentage =
        (parseFloat(profit) / calculatedSellingPrice) * 100;
    } else if (profit_margin_percentage && !selling_price) {
      // If margin percentage is provided, calculate selling price and profit
      // Formula: selling_price = purchasing_price / (1 - margin_percentage/100)
      const marginDecimal = parseFloat(profit_margin_percentage) / 100;
      calculatedSellingPrice =
        parseFloat(purchasing_price) / (1 - marginDecimal);
      calculatedProfit = calculatedSellingPrice - parseFloat(purchasing_price);
    }

    // Add new variant with unique ID
    const currentVariants = product.variants || [];
    const newVariant = {
      id: Date.now(), // Simple unique ID
      size,
      unit,
      purchasing_price: parseFloat(purchasing_price),
      profit: calculatedProfit ? parseFloat(calculatedProfit) : 0,
      profit_margin_percentage: calculatedMarginPercentage
        ? parseFloat(calculatedMarginPercentage)
        : 0,
      selling_price: calculatedSellingPrice
        ? parseFloat(calculatedSellingPrice)
        : parseFloat(purchasing_price),
    };
    const updatedVariants = [...currentVariants, newVariant];

    // Update product with new variants array
    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    res.status(201).json(newVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// PUT - Update a specific variant
router.put("/:productId/variants/:variantId", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    profit,
    profit_margin_percentage,
    selling_price,
  } = req.body;
  const { productId, variantId } = req.params;

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    // Find the variant being updated to get old price
    const currentVariants = product.variants || [];
    const oldVariant = currentVariants.find((v) => v.id == variantId);
    const oldPrice = oldVariant?.purchasing_price;

    // Calculate missing values
    let calculatedProfit = profit;
    let calculatedMarginPercentage = profit_margin_percentage;
    let calculatedSellingPrice = selling_price;

    if (selling_price && !profit && !profit_margin_percentage) {
      // If only selling price is provided, calculate profit and margin
      calculatedProfit =
        parseFloat(selling_price) - parseFloat(purchasing_price);
      calculatedMarginPercentage =
        (calculatedProfit / parseFloat(selling_price)) * 100;
    } else if (profit && !selling_price) {
      // If profit is provided, calculate selling price and margin percentage
      calculatedSellingPrice =
        parseFloat(purchasing_price) + parseFloat(profit);
      calculatedMarginPercentage =
        (parseFloat(profit) / calculatedSellingPrice) * 100;
    } else if (profit_margin_percentage && !selling_price) {
      // If margin percentage is provided, calculate selling price and profit
      // Formula: selling_price = purchasing_price / (1 - margin_percentage/100)
      const marginDecimal = parseFloat(profit_margin_percentage) / 100;
      calculatedSellingPrice =
        parseFloat(purchasing_price) / (1 - marginDecimal);
      calculatedProfit = calculatedSellingPrice - parseFloat(purchasing_price);
    }

    // Update the specific variant
    const updatedVariants = currentVariants.map((v) =>
      v.id == variantId
        ? {
            ...v,
            size,
            unit,
            purchasing_price: parseFloat(purchasing_price),
            profit: calculatedProfit
              ? parseFloat(calculatedProfit)
              : profit || v.profit || 0,
            profit_margin_percentage: calculatedMarginPercentage
              ? parseFloat(calculatedMarginPercentage)
              : profit_margin_percentage || v.profit_margin_percentage || 0,
            selling_price: calculatedSellingPrice
              ? parseFloat(calculatedSellingPrice)
              : selling_price ||
                v.selling_price ||
                parseFloat(purchasing_price),
          }
        : v,
    );

    // Update product with modified variants array
    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    // If purchase price changed, update customer prices
    if (oldPrice && oldPrice !== parseFloat(purchasing_price)) {
      await updateCustomerPricesForVariant(
        productId,
        variantId,
        parseFloat(purchasing_price),
        oldPrice,
      );
    }

    const updatedVariant = updatedVariants.find((v) => v.id == variantId);
    res.json(updatedVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// DELETE - Remove a specific variant
router.delete("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from("products")
      .select("variants")
      .eq("id", productId)
      .single();

    if (fetchError) throw fetchError;

    // Remove the specific variant
    const currentVariants = product.variants || [];
    const updatedVariants = currentVariants.filter((v) => v.id != variantId);

    // Update product with filtered variants array
    const { error: updateError } = await supabase
      .from("products")
      .update({ variants: updatedVariants })
      .eq("id", productId);

    if (updateError) throw updateError;

    res.json({ message: "Variant deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// Helper function to update customer prices
async function updateCustomerPricesForVariant(
  productId,
  variantId,
  newPrice,
  oldPrice,
) {
  try {
    // Get all customer prices for this product/variant
    const { data: customerPrices, error: fetchPricesError } = await supabase
      .from("customer_product")
      .select("*")
      .eq("product_id", productId)
      .eq("variant_id", variantId);

    if (fetchPricesError) {
      console.error("Error fetching customer prices:", fetchPricesError);
      return;
    }

    // Update each customer price
    for (const customerPrice of customerPrices) {
      const priceDifference = newPrice - oldPrice;

      let newSellingPrice;
      let newMargin;
      let newMarginPercentage;

      if (customerPrice.margin_percentage > 0) {
        // Recalculate using margin percentage
        newMargin = (newPrice * customerPrice.margin_percentage) / 100;
        newSellingPrice = newPrice + newMargin;
        newMarginPercentage = customerPrice.margin_percentage;
      } else if (customerPrice.margin > 0) {
        // Keep same margin amount
        newMargin = customerPrice.margin;
        newSellingPrice = newPrice + newMargin;
        newMarginPercentage = (newMargin / newSellingPrice) * 100;
      } else {
        // Just add the price difference
        newSellingPrice = customerPrice.selling_price + priceDifference;
        newMargin = customerPrice.margin;
        newMarginPercentage = customerPrice.margin_percentage;
      }

      const { error: updatePriceError } = await supabase
        .from("customer_product")
        .update({
          purchasing_price: newPrice,
          selling_price: newSellingPrice,
          margin: newMargin,
          margin_percentage: newMarginPercentage,
        })
        .eq("id", customerPrice.id);

      if (updatePriceError) {
        console.error("Error updating customer price:", updatePriceError);
      }
    }
  } catch (err) {
    console.error("Error in updateCustomerPricesForVariant:", err);
  }
}

export default router;
