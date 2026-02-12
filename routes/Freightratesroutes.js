import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// Helper function to get the applicable air freight rate by tier
const getAirFreightRateByTier = (tier, rateData) => {
  if (!rateData || !tier) return 0;
  switch (tier) {
    case 'gross+45kg':
      return parseFloat(rateData.rate_45kg);
    case 'gross+100kg':
      return parseFloat(rateData.rate_100kg);
    case 'gross+300kg':
      return parseFloat(rateData.rate_300kg);
    case 'gross+500kg':
      return parseFloat(rateData.rate_500kg);
    default:
      return 0;
  }
}

// Helper function to recalculate products affected by air freight rate change
const recalculateAirFreightProducts = async (country, airportCode, newRateData) => {
  try {
    console.log(`\n=== Starting Air Freight Recalculation ===`)
    console.log(`Country: ${country}`)
    console.log(`Airport Code: ${airportCode}`)
    console.log(`New Rates:`, newRateData)
    
    // Get current USD rate
    const { data: usdRateData, error: usdError } = await supabase
      .from('usd_rates')
      .select('rate')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (usdError || !usdRateData) {
      console.error('Could not fetch USD rate for recalculation:', usdError)
      return { updated: 0, errors: 0, message: 'USD rate not found' }
    }

    const currentUsdRate = parseFloat(usdRateData.rate)
    console.log(`Current USD Rate: ${currentUsdRate}`)

    // Find customers with matching country and airport code (case-insensitive)
    const { data: allCustomers, error: custError } = await supabase
      .from('exportcustomers')
      .select('cus_id, country, airport_code, cus_name')

    if (custError) {
      console.error('Error fetching customers:', custError)
      return { updated: 0, errors: 0, message: 'Error fetching customers' }
    }

    console.log(`\nTotal customers in database: ${allCustomers?.length || 0}`)

    // Filter customers with case-insensitive matching
    const customers = allCustomers.filter(customer => 
      customer.country && customer.airport_code &&
      customer.country.toLowerCase().trim() === country.toLowerCase().trim() &&
      customer.airport_code.toUpperCase().trim() === airportCode.toUpperCase().trim()
    )

    console.log(`Matching customers found: ${customers.length}`)
    if (customers.length > 0) {
      console.log('Matching customers:', customers.map(c => `${c.cus_name} (${c.country} - ${c.airport_code})`))
    }

    if (customers.length === 0) {
      console.log(`No customers found for ${country} - ${airportCode}`)
      return { updated: 0, errors: 0, message: 'No matching customers found' }
    }

    const customerIds = customers.map(c => c.cus_id)

    // Get all products for these customers with air freight
    const { data: products, error: fetchError } = await supabase
      .from('exportcustomer_product')
      .select('*')
      .in('cus_id', customerIds)

    if (fetchError) {
      console.error('Error fetching products:', fetchError)
      throw fetchError
    }

    console.log(`\nTotal products for these customers: ${products?.length || 0}`)

    // Filter for air freight products
    const airFreightProducts = products.filter(p => p.freight_type === 'air')
    console.log(`Air freight products: ${airFreightProducts.length}`)

    if (airFreightProducts.length === 0) {
      console.log('No air freight products found for these customers')
      return { updated: 0, errors: 0, message: 'No air freight products found' }
    }

    let updated = 0
    let errors = 0

    // Recalculate each product
    for (const product of airFreightProducts) {
      try {
        const multiplier = parseFloat(product.multiplier) || 0
        const divisor = parseFloat(product.divisor) || 1
        const gross_weight_tier = product.gross_weight_tier

        console.log(`\nProcessing product ID ${product.id}:`)
        console.log(`  - Weight Tier: ${gross_weight_tier}`)
        console.log(`  - Multiplier: ${multiplier}`)
        console.log(`  - Divisor: ${divisor}`)

        if (!gross_weight_tier || multiplier === 0) {
          console.log(`  ⚠️ Skipping - missing weight tier or multiplier`)
          continue
        }

        // Calculate new freight cost
        const applicableRate = getAirFreightRateByTier(gross_weight_tier, newRateData)
        const newFreightCost = (multiplier * applicableRate) / divisor

        console.log(`  - Applicable Rate: $${applicableRate}/kg`)
        console.log(`  - New Freight Cost: $${newFreightCost.toFixed(2)}`)

        // Get cost values (stored in USD)
        const export_doc = parseFloat(product.export_doc) || 0
        const transport_cost = parseFloat(product.transport_cost) || 0
        const loading_cost = parseFloat(product.loading_cost) || 0
        const airway_cost = parseFloat(product.airway_cost) || 0
        const forwardHandling_cost = parseFloat(product.forwardHandling_cost) || 0
        const exfactoryprice = parseFloat(product.exfactoryprice) || 0

        // Calculate total costs in USD
        const totalCostsUSD = export_doc + transport_cost + loading_cost + airway_cost + forwardHandling_cost

        // Convert total costs to LKR
        const totalCostsLKR = totalCostsUSD * currentUsdRate

        // Calculate new FOB in LKR
        const newFobPrice = exfactoryprice + totalCostsLKR

        // Calculate new CNF in USD (FOB in USD + Freight)
        const fobInUSD = newFobPrice / currentUsdRate
        const newCnf = fobInUSD + newFreightCost

        console.log(`  - Old FOB: Rs.${product.fob_price}`)
        console.log(`  - New FOB: Rs.${newFobPrice.toFixed(2)}`)
        console.log(`  - New CNF: $${newCnf.toFixed(2)}`)

        // Update the product
        const { error: updateError } = await supabase
          .from('exportcustomer_product')
          .update({
            freight_cost: parseFloat(newFreightCost.toFixed(2)),
            fob_price: parseFloat(newFobPrice.toFixed(2)),
            cnf: parseFloat(newCnf.toFixed(2))
          })
          .eq('id', product.id)

        if (updateError) {
          console.error(`  ❌ Error updating product ${product.id}:`, updateError)
          errors++
        } else {
          console.log(`  ✅ Successfully updated`)
          updated++
        }
      } catch (err) {
        console.error(`  ❌ Error processing product ${product.id}:`, err)
        errors++
      }
    }

    console.log(`\n=== Recalculation Complete ===`)
    console.log(`Updated: ${updated}`)
    console.log(`Errors: ${errors}`)
    console.log(`============================\n`)

    return { updated, errors }
  } catch (err) {
    console.error('Error in recalculateAirFreightProducts:', err)
    throw err
  }
}

// GET all freight rates (sorted by most recent)
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100

    const { data: rates, error } = await supabase
      .from('freight_rates')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    res.json(rates)
  } catch (err) {
    console.error('Error fetching freight rates:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET freight rates for a specific country
router.get('/country/:country', async (req, res) => {
  try {
    const { country } = req.params

    const { data: rates, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .order('updated_at', { ascending: false })

    if (error) throw error

    res.json(rates)
  } catch (err) {
    console.error('Error fetching freight rates by country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET latest rate for a specific country and airport
router.get('/country/:country/airport/:airport_code/latest', async (req, res) => {
  try {
    const { country, airport_code } = req.params

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .eq('airport_code', airport_code.toUpperCase())
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this country and airport' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching latest rate by country and airport:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET latest rate for a specific country (any airport)
router.get('/country/:country/latest', async (req, res) => {
  try {
    const { country } = req.params

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this country' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching latest rate by country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// POST - Create new freight rate and recalculate affected products
router.post('/', async (req, res) => {
  try {
    const { 
      country, 
      airport_code, 
      airport_name, 
      rate_45kg, 
      rate_100kg, 
      rate_300kg, 
      rate_500kg, 
      date 
    } = req.body

    if (!country || !airport_code || !airport_name || 
        !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ 
        message: 'Country, airport code, airport name, and all weight tier rates are required' 
      })
    }

    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const insertData = {
      country: country.trim(),
      airport_code: airport_code.trim().toUpperCase(),
      airport_name: airport_name.trim(),
      rate_45kg: parseFloat(rate_45kg),
      rate_100kg: parseFloat(rate_100kg),
      rate_300kg: parseFloat(rate_300kg),
      rate_500kg: parseFloat(rate_500kg),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: newRate, error } = await supabase
      .from('freight_rates')
      .insert(insertData)
      .select()
      .single()

    if (error) {
      console.error('Supabase insert error:', error)
      throw error
    }

    // Recalculate affected products
    const recalcResult = await recalculateAirFreightProducts(
      insertData.country,
      insertData.airport_code,
      {
        rate_45kg: insertData.rate_45kg,
        rate_100kg: insertData.rate_100kg,
        rate_300kg: insertData.rate_300kg,
        rate_500kg: insertData.rate_500kg
      }
    )

    res.status(201).json({
      message: 'Freight rate added successfully',
      data: newRate,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error adding freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// PUT - Update existing freight rate and recalculate affected products
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { 
      country, 
      airport_code, 
      airport_name, 
      rate_45kg, 
      rate_100kg, 
      rate_300kg, 
      rate_500kg, 
      date 
    } = req.body

    if (!country || !airport_code || !airport_name || 
        !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ 
        message: 'Country, airport code, airport name, and all weight tier rates are required' 
      })
    }

    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const updateData = {
      country: country.trim(),
      airport_code: airport_code.trim().toUpperCase(),
      airport_name: airport_name.trim(),
      rate_45kg: parseFloat(rate_45kg),
      rate_100kg: parseFloat(rate_100kg),
      rate_300kg: parseFloat(rate_300kg),
      rate_500kg: parseFloat(rate_500kg),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: updatedRate, error } = await supabase
      .from('freight_rates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Supabase update error:', error)
      throw error
    }

    // Recalculate affected products
    const recalcResult = await recalculateAirFreightProducts(
      updateData.country,
      updateData.airport_code,
      {
        rate_45kg: updateData.rate_45kg,
        rate_100kg: updateData.rate_100kg,
        rate_300kg: updateData.rate_300kg,
        rate_500kg: updateData.rate_500kg
      }
    )

    res.json({
      message: 'Freight rate updated successfully',
      data: updatedRate,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error updating freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// DELETE - Remove freight rate
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('freight_rates')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Freight rate deleted successfully' })
  } catch (err) {
    console.error('Error deleting freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate for specific date, country, and airport
router.get('/date/:date/country/:country/airport/:airport_code', async (req, res) => {
  try {
    const { date, country, airport_code } = req.params
    const searchDate = new Date(date)
    
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .eq('airport_code', airport_code.toUpperCase())
      .gte('date', startOfDay)
      .lte('date', endOfDay)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this date, country, and airport' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching rate by date, country, and airport:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate for specific date and country (legacy - any airport)
router.get('/date/:date/country/:country', async (req, res) => {
  try {
    const { date, country } = req.params
    const searchDate = new Date(date)
    
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .gte('date', startOfDay)
      .lte('date', endOfDay)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this date and country' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching rate by date and country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

export default router