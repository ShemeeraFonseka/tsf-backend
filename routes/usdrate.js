import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// GET current USD rate (most recent)
router.get('/', async (req, res) => {  // Changed from '/usd-rate' to '/'
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
router.get('/history', async (req, res) => {  // Changed from '/usd-rate/history' to '/history'
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

// POST - Create/Add new USD rate
router.post('/', async (req, res) => {  // Changed from '/usd-rate' to '/'
  try {
    const { rate, date } = req.body

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: 'Valid rate is required' })
    }

    const { data: newRate, error } = await supabase
      .from('usd_rates')
      .insert({
        rate: parseFloat(rate),
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({
      message: 'USD rate updated successfully',
      rate: newRate.rate,
      date: newRate.date,
      updated_at: newRate.updated_at
    })
  } catch (err) {
    console.error('Error updating USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// DELETE - Remove a specific rate entry
router.delete('/:id', async (req, res) => {  // Changed from '/usd-rate/:id' to '/:id'
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
router.get('/date/:date', async (req, res) => {  // Changed from '/usd-rate/date/:date' to '/date/:date'
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

// PUT - Update an existing rate entry
router.put('/:id', async (req, res) => {  // Changed from '/usd-rate/:id' to '/:id'
  try {
    const { id } = req.params
    const { rate, date } = req.body

    if (!rate || rate <= 0) {
      return res.status(400).json({ message: 'Valid rate is required' })
    }

    const { data: updatedRate, error } = await supabase
      .from('usd_rates')
      .update({
        rate: parseFloat(rate),
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'USD rate updated successfully',
      rate: updatedRate.rate,
      date: updatedRate.date,
      updated_at: updatedRate.updated_at
    })
  } catch (err) {
    console.error('Error updating USD rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

export default router