import { useEffect, useState } from 'react'
import { CH } from '../../../shared/ipc'

export interface TaxonomyProgress {
  done: number
  total: number
  field: 'tags' | 'authors'
  finished?: boolean
}

/** 订阅主进程推来的批量改写进度 */
export function useTaxonomyProgress(): TaxonomyProgress | null {
  const [progress, setProgress] = useState<TaxonomyProgress | null>(null)

  useEffect(() => {
    const off = window.api.on(CH.evtTaxonomy, (value) => {
      setProgress(value as TaxonomyProgress)
    })
    return off
  }, [])

  return progress
}
