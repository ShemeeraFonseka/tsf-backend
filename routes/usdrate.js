import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// Helper function to recalculate all product prices with new USD rate
const recalculateProductPrices = async (newUsdRate) => {
  try {
    console.log(`Starting recalculation with new USD rate: ${newUsdRate}`)
    
    // Fetch all products
    const { data: products, error: fetchError } = await supabase
      .from('exportcustomer_product')
      .select('*')

    if (fetchError) throw fetchError

    if (!products || products.length === 0) {
      console.log('No products to recalculate')
      return { updated: 0, errors: 0 }
    }

    let updated = 0
    let errors = 0

    // Recalculate each product
    for (const product of products) {
      try {
        // Get cost values (stored in USD)
        const export_doc = parseFloat(product.export_doc) || 0
        const transport_cost = parseFloat(product.transport_cost) || 0
        const loading_cost = parseFloat(product.loading_cost) || 0
        const airway_cost = parseFloat(product.airway_cost) || 0
        const forwardHandling_cost = parseFloat(product.forwardHandling_cost) || 0
        const freight_cost = parseFloat(product.freight_cost) || 0
        const exfactoryprice = parseFloat(product.exfactoryprice) || 0

        // Calculate total costs in USD
        const totalCostsUSD = export_doc + transport_cost + loading_cost + airway_cost + forwardHandling_cost

        // Convert total costs to LKR using new USD rate
        const totalCostsLKR = totalCostsUSD * newUsdRate

        // Calculate new FOB in LKR
        const newFobPrice = exfactoryprice + totalCostsLKR

        // Calculate new CNF in USD (FOB in USD + Freight)
        const fobInUSD = newFobPrice / newUsdRate
        const newCnf = fobInUSD + freight_cost

        // Update the product
        const { error: updateError } = await supabase
          .from('exportcustomer_product')
          .update({
            fob_price: parseFloat(newFobPrice.toFixed(2)),
            cnf: parseFloat(newCnf.toFixed(2))
          })
          .eq('id', product.id)

        if (updateError) {
          console.error(`Error updating product ${product.id}:`, updateError)
          errors++
        } else {
          updated++
        }
      } catch (err) {
        console.error(`Error processing product ${product.id}:`, err)
        errors++
      }
    }

    console.log(`Recalculation complete: ${updated} updated, ${errors} errors`)
    return { updated, errors }
  } catch (err) {
    console.error('Error in recalculateProductPrices:', err)
    throw err
  }
}

// GET current USD rate (most recent)
router.get('/', async (req, res) => {
  try {
    const { data: currentRate, error } = await supabase
      .from('usd_rates')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No USD rate found' })
      }
      throw error
    }

    res.json({
      rate: currentRate.rate,
      date: currentRate.date,
      updated_at: currentRate.updated_at
    })
  } catch (err) {
    console.error('Error fetching USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate history (last 30 entries by default)
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30

    const { data: history, error } = await supabase
      .from('usd_rates')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    res.json(history)
  } catch (err) {
    console.error('Error fetching USD rate history:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// POST - Create/Add new USD rate and recalculate all products
router.post('/', async (req, res) => {
  try {
    const { rate, date } = req.body

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: 'Valid rate is required' })
    }

    const newRate = parseFloat(rate)

    // Insert new USD rate
    const { data: newRateData, error } = await supabase
      .from('usd_rates')
      .insert({
        rate: newRate,
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) throw error

    // Recalculate all product prices with new USD rate
    const recalcResult = await recalculateProductPrices(newRate)

    res.status(201).json({
      message: 'USD rate updated successfully',
      rate: newRateData.rate,
      date: newRateData.date,
      updated_at: newRateData.updated_at,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error updating USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// DELETE - Remove a specific rate entry
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('usd_rates')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Rate entry deleted successfully' })
  } catch (err) {
    console.error('Error deleting USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate for a specific date
router.get('/date/:date', async (req, res) => {
  try {
    const { date } = req.params
    const searchDate = new Date(date)
    
    // Get start and end of day
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

    const { data: rate, error } = await supabase
      .from('usd_rates')
      .select('*')
      .gte('date', startOfDay)
      .lte('date', endOfDay)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this date' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching rate by date:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// PUT - Update an existing rate entry and recalculate products
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { rate, date } = req.body

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: 'Valid rate is required' })
    }

    const newRate = parseFloat(rate)

    const { data: updatedRate, error } = await supabase
      .from('usd_rates')
      .update({
        rate: newRate,
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    // Recalculate all product prices with updated USD rate
    const recalcResult = await recalculateProductPrices(newRate)

    res.json({
      message: 'USD rate updated successfully',
      rate: updatedRate.rate,
      date: updatedRate.date,
      updated_at: updatedRate.updated_at,
      recalculation: {
        productsUpdated: recalcResult.updated,
        errors: recalcResult.errors
      }
    })
  } catch (err) {
    console.error('Error updating USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

export default router