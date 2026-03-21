(function initTunanPhotoshopService(global) {
  class TunanPhotoshopService {
    constructor() {
      this.captureService = new global.TunanCaptureService(this)
      this.realtimeState = {
        baselinePreview: null,
        lastContextKey: '',
        lastSentAt: 0,
      }
    }

    async getBasicInfo() {
      try {
        const photoshop = require('photoshop')
        const doc = photoshop.app.activeDocument

        return {
          connected: true,
          hostName: 'Photoshop',
          version: 'UXP WebView Mode',
          hasDocument: !!doc,
          documentName: doc?.name || '',
        }
      } catch (error) {
        return {
          connected: false,
          hostName: 'Photoshop',
          version: 'UXP WebView Mode',
          error: error?.message || String(error),
        }
      }
    }

    async collectActiveContext(settings = {}) {
      return this.captureService.collectActiveContext(settings)
    }

    async collectActiveContextForApi(settings = {}) {
      const photoshop = require('photoshop')
      const doc = photoshop.app.activeDocument

      if (!doc) {
        throw new Error('请先在 Photoshop 中打开一个文档')
      }

      const captureMode = settings.captureMode || 'merged'
      const layerBoundaryMode = settings.layerBoundaryMode || 'document'
      const useSelection = settings.useSelection !== false
      const hasSelection = useSelection ? await this.checkSelection(doc) : false

      if (hasSelection) {
        return this.exportApiSelectionCapture(doc, settings, {
          captureMode,
          layerBoundaryMode,
        })
      }

      if (captureMode === 'current') {
        return layerBoundaryMode === 'content'
          ? this.exportApiCurrentLayerContent(doc, settings)
          : this.exportApiCurrentLayerDocument(doc, settings)
      }

      return this.exportApiMergedDocument(doc, settings)
    }

    async runRealtimeModal(callback) {
      const photoshop = require('photoshop')
      return photoshop.core.executeAsModal(async () => callback(), {
        commandName: '图南画桥实时检测',
      })
    }

    resetRealtimeState() {
      this.realtimeState = {
        baselinePreview: null,
        lastContextKey: '',
        lastSentAt: 0,
      }
    }

    commitRealtimeBaseline(decision = {}) {
      const previewBytes = decision?.snapshot?.previewBytes
      if (!(previewBytes instanceof Uint8Array) || !previewBytes.length) {
        return
      }

      this.realtimeState.baselinePreview = new Uint8Array(previewBytes)
      this.realtimeState.lastContextKey = decision.snapshot?.contextKey || ''
      this.realtimeState.lastSentAt = Date.now()
    }

    async refreshRealtimeBaseline(settings = {}) {
      const snapshot = await this.runRealtimeModal(() => this.captureRealtimeSnapshot(settings))
      if (snapshot?.previewBytes?.length) {
        this.commitRealtimeBaseline({ snapshot })
        return true
      }
      return false
    }

    async evaluateRealtimeTick(settings = {}) {
      const snapshot = await this.runRealtimeModal(() => this.captureRealtimeSnapshot(settings))
      if (!snapshot?.previewBytes?.length) {
        return {
          shouldRun: false,
          reason: snapshot?.reason || 'unavailable',
          snapshot,
        }
      }

      if (!this.realtimeState.baselinePreview) {
        return {
          shouldRun: true,
          reason: 'initial',
          snapshot,
        }
      }

      if (snapshot.contextKey !== this.realtimeState.lastContextKey) {
        return {
          shouldRun: true,
          reason: 'context_changed',
          snapshot,
        }
      }

      const diff = this.compareRealtimePreview(snapshot.previewBytes, this.realtimeState.baselinePreview)
      const thresholds = this.getRealtimeThresholds(settings.realtimeSensitivity)
      return {
        shouldRun:
          diff.meanScore >= thresholds.mean ||
          diff.maxTileScore >= thresholds.tile ||
          diff.changedRatio >= thresholds.changed ||
          diff.maxTileChangedRatio >= thresholds.hotspot,
        reason: 'diff_checked',
        diff,
        thresholds,
        snapshot,
      }
    }

    getRealtimeThresholds(rawSensitivity = 5) {
      const sensitivity = Math.min(10, Math.max(1, Number(rawSensitivity) || 5))
      const ratio = (sensitivity - 1) / 9

      return {
        sensitivity,
        mean: Number((4.2 - ratio * 3.0).toFixed(2)),
        tile: Number((7.4 - ratio * 5.0).toFixed(2)),
        changed: Number((9.5 - ratio * 7.0).toFixed(2)),
        hotspot: Number((18 - ratio * 13).toFixed(2)),
      }
    }

    compareRealtimePreview(currentPreview, baselinePreview) {
      if (!(currentPreview instanceof Uint8Array) || !(baselinePreview instanceof Uint8Array)) {
        return {
          meanScore: 100,
          maxTileScore: 100,
          changedRatio: 100,
          maxTileChangedRatio: 100,
        }
      }

      if (currentPreview.length !== baselinePreview.length) {
        return {
          meanScore: 100,
          maxTileScore: 100,
          changedRatio: 100,
          maxTileChangedRatio: 100,
        }
      }

      const pixelCount = Math.floor(currentPreview.length / 4)
      if (!pixelCount) {
        return {
          meanScore: 0,
          maxTileScore: 0,
          changedRatio: 0,
          maxTileChangedRatio: 0,
        }
      }

      const previewSize = 128
      const tileSize = 4
      const tileColumns = previewSize / tileSize
      const tileRows = previewSize / tileSize
      const tileCount = tileColumns * tileRows
      const tileTotals = new Float32Array(tileCount)
      const tileSamples = new Uint16Array(tileCount)
      const tileChanged = new Uint16Array(tileCount)
      let totalDiff = 0
      let changedPixels = 0
      const changedCutoff = 0.035

      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const offset = pixelIndex * 4
        const redDiff = Math.abs(currentPreview[offset] - baselinePreview[offset]) / 255
        const greenDiff = Math.abs(currentPreview[offset + 1] - baselinePreview[offset + 1]) / 255
        const blueDiff = Math.abs(currentPreview[offset + 2] - baselinePreview[offset + 2]) / 255
        const maxChannelDiff = Math.max(redDiff, greenDiff, blueDiff)
        const avgChannelDiff = (redDiff + greenDiff + blueDiff) / 3
        const colorDiff = maxChannelDiff * 0.65 + avgChannelDiff * 0.35
        const alphaDiff = Math.abs(currentPreview[offset + 3] - baselinePreview[offset + 3]) / 255
        const pixelDiff = colorDiff * 0.88 + alphaDiff * 0.12
        totalDiff += pixelDiff

        const x = pixelIndex % previewSize
        const y = Math.floor(pixelIndex / previewSize)
        const tileIndex = Math.floor(y / tileSize) * tileColumns + Math.floor(x / tileSize)
        tileTotals[tileIndex] += pixelDiff
        tileSamples[tileIndex] += 1

        if (pixelDiff >= changedCutoff) {
          changedPixels += 1
          tileChanged[tileIndex] += 1
        }
      }

      let maxTileScore = 0
      let maxTileChangedRatio = 0
      for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
        if (!tileSamples[tileIndex]) continue
        const tileScore = (tileTotals[tileIndex] / tileSamples[tileIndex]) * 100
        if (tileScore > maxTileScore) {
          maxTileScore = tileScore
        }

        const tileChangedRatio = (tileChanged[tileIndex] / tileSamples[tileIndex]) * 100
        if (tileChangedRatio > maxTileChangedRatio) {
          maxTileChangedRatio = tileChangedRatio
        }
      }

      return {
        meanScore: Number(((totalDiff / pixelCount) * 100).toFixed(2)),
        maxTileScore: Number(maxTileScore.toFixed(2)),
        changedRatio: Number(((changedPixels / pixelCount) * 100).toFixed(2)),
        maxTileChangedRatio: Number(maxTileChangedRatio.toFixed(2)),
      }
    }

    async captureRealtimeSnapshot(settings = {}) {
      const photoshop = require('photoshop')
      const doc = photoshop.app.activeDocument

      if (!doc) {
        return { reason: 'no_document' }
      }

      const previewTarget = { width: 128, height: 128 }
      const captureMode = settings.captureMode === 'current' ? 'current' : 'merged'
      const layerBoundaryMode = settings.layerBoundaryMode === 'content' ? 'content' : 'document'
      const useSelection = settings.useSelection !== false
      const hasSelection = useSelection
        ? (this.isQuickMaskMode(doc) || await this.checkSelection(doc))
        : false
      const docBounds = this.getDocumentBounds(doc)
      const activeLayer = captureMode === 'current' ? doc.activeLayers?.[0] || null : null

      if (captureMode === 'current' && !activeLayer) {
        return { reason: 'no_active_layer' }
      }

      if (hasSelection) {
        return this.captureRealtimeSelectionSnapshot(doc, settings, {
          activeLayer,
          captureMode,
          layerBoundaryMode,
          docBounds,
          previewTarget,
        })
      }

      if (captureMode === 'current') {
        return layerBoundaryMode === 'content'
          ? this.captureRealtimeCurrentLayerContent(doc, settings, activeLayer, previewTarget)
          : this.captureRealtimeCurrentLayerDocument(doc, settings, activeLayer, docBounds, previewTarget)
      }

      return this.captureRealtimeMergedDocument(doc, settings, docBounds, previewTarget)
    }

    async captureRealtimeCurrentLayerContent(doc, settings, activeLayer, previewTarget) {
      const pixelCapture = await this.captureService.getLayerPixelCapture(doc, activeLayer, { targetSize: previewTarget })

      try {
        const bounds = pixelCapture?.bounds
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
          return { reason: 'no_content' }
        }

        const previewBytes = await this.captureService.toRgbaPixels(pixelCapture)
        if (!this.hasVisiblePixels(previewBytes)) {
          return { reason: 'no_content' }
        }

        return {
          previewBytes,
          contextKey: this.buildRealtimeContextKey({
            docId: doc.id ?? doc._id ?? doc.name,
            layerId: activeLayer?.id || null,
            captureMode: 'current',
            layerBoundaryMode: 'content',
            hasSelection: false,
            sizeLimit: settings.sizeLimit || 'original',
            customSizeValue: Number(settings.customSizeValue || 0),
            edgeControl: settings.edgeControl === 'short' ? 'short' : 'long',
            bounds,
          }),
        }
      } finally {
        this.captureService.disposeCapture(pixelCapture)
      }
    }

    async captureRealtimeCurrentLayerDocument(doc, settings, activeLayer, docBounds, previewTarget) {
      const pixelCapture = await this.captureService.getLayerPixelCapture(doc, activeLayer, {
        sourceBounds: docBounds,
        fallbackBounds: docBounds,
        targetSize: previewTarget,
      })

      try {
        const previewBytes = await this.captureService.toRgbaPixels(pixelCapture)
        if (!this.hasVisiblePixels(previewBytes)) {
          return { reason: 'no_content' }
        }

        return {
          previewBytes,
          contextKey: this.buildRealtimeContextKey({
            docId: doc.id ?? doc._id ?? doc.name,
            layerId: activeLayer?.id || null,
            captureMode: 'current',
            layerBoundaryMode: 'document',
            hasSelection: false,
            sizeLimit: settings.sizeLimit || 'original',
            customSizeValue: Number(settings.customSizeValue || 0),
            edgeControl: settings.edgeControl === 'short' ? 'short' : 'long',
            bounds: docBounds,
          }),
        }
      } finally {
        this.captureService.disposeCapture(pixelCapture)
      }
    }

    async captureRealtimeMergedDocument(doc, settings, docBounds, previewTarget) {
      const pixelCapture = await this.captureService.getDocumentPixelCapture(doc, {
        sourceBounds: docBounds,
        targetSize: previewTarget,
      })

      try {
        const previewBytes = await this.captureService.toRgbaPixels(pixelCapture)
        return {
          previewBytes,
          contextKey: this.buildRealtimeContextKey({
            docId: doc.id ?? doc._id ?? doc.name,
            layerId: null,
            captureMode: 'merged',
            layerBoundaryMode: 'document',
            hasSelection: false,
            sizeLimit: settings.sizeLimit || 'original',
            customSizeValue: Number(settings.customSizeValue || 0),
            edgeControl: settings.edgeControl === 'short' ? 'short' : 'long',
            bounds: docBounds,
          }),
        }
      } finally {
        this.captureService.disposeCapture(pixelCapture)
      }
    }

    async captureRealtimeSelectionSnapshot(
      doc,
      settings,
      { activeLayer, captureMode, layerBoundaryMode, docBounds, previewTarget },
    ) {
      const selectionBounds = await this.getSelectionBounds(doc)
      if (!selectionBounds || selectionBounds.width <= 0 || selectionBounds.height <= 0) {
        return { reason: 'no_selection' }
      }

      let effectiveSelectionBounds = { ...selectionBounds }
      let sendLimitBounds = docBounds

      if (captureMode === 'current') {
        const layerContentCapture = await this.captureService.getLayerPixelCapture(doc, activeLayer, {
          fallbackBounds: docBounds,
        })
        const layerBounds = layerContentCapture?.bounds
        this.captureService.disposeCapture(layerContentCapture)

        if (!layerBounds || layerBounds.width <= 0 || layerBounds.height <= 0) {
          return { reason: 'no_content' }
        }

        if (!this.boundsOverlap(selectionBounds, layerBounds)) {
          return { reason: 'selection_no_content' }
        }

        if (layerBoundaryMode === 'content') {
          const croppedSelectionBounds = this.intersectBounds(selectionBounds, layerBounds)
          if (!croppedSelectionBounds) {
            return { reason: 'selection_no_content' }
          }
          effectiveSelectionBounds = croppedSelectionBounds
          sendLimitBounds = layerBounds
        }
      }

      const selectionSendMode = settings.selectionSendMode === 'shape' ? 'shape' : 'rect'
      const selectionExpandPx = selectionSendMode === 'rect'
        ? this.normalizeExpandPx(settings.selectionExpandPx)
        : 0
      const sendBounds = selectionSendMode === 'rect'
        ? this.expandBounds(effectiveSelectionBounds, selectionExpandPx, sendLimitBounds)
        : { ...effectiveSelectionBounds }

      const selectionCapture = await this.captureService.getSelectionPixelCapture(doc, {
        sourceBounds: sendBounds,
        targetSize: previewTarget,
        expectedBounds: effectiveSelectionBounds,
      })
      if (!selectionCapture) {
        return { reason: 'no_selection' }
      }

      let imageCapture = null
      try {
        imageCapture = captureMode === 'current'
          ? await this.captureService.getLayerPixelCapture(doc, activeLayer, {
            sourceBounds: sendBounds,
            fallbackBounds: sendBounds,
            targetSize: previewTarget,
          })
          : await this.captureService.getDocumentPixelCapture(doc, {
            sourceBounds: sendBounds,
            targetSize: previewTarget,
          })

        const previewBytes = selectionSendMode === 'shape'
          ? await this.buildRealtimeMaskedPreview(imageCapture, selectionCapture, captureMode === 'current')
          : await this.captureService.toRgbaPixels(imageCapture)

        const selectionSignature = this.hashBytes(await this.captureService.toSingleChannelPixels(selectionCapture))

        if (!this.hasVisiblePixels(previewBytes) && selectionSendMode !== 'shape') {
          return { reason: 'selection_no_content' }
        }

        return {
          previewBytes,
          contextKey: this.buildRealtimeContextKey({
            docId: doc.id ?? doc._id ?? doc.name,
            layerId: activeLayer?.id || null,
            captureMode,
            layerBoundaryMode,
            hasSelection: true,
            selectionSendMode,
            selectionExpandPx,
            sizeLimit: settings.sizeLimit || 'original',
            customSizeValue: Number(settings.customSizeValue || 0),
            edgeControl: settings.edgeControl === 'short' ? 'short' : 'long',
            selectionBounds: effectiveSelectionBounds,
            sendBounds,
            selectionSignature,
          }),
        }
      } finally {
        this.captureService.disposeCapture(imageCapture)
        this.captureService.disposeCapture(selectionCapture)
      }
    }

    async buildRealtimeMaskedPreview(imageCapture, selectionCapture, preserveSourceAlpha = false) {
      const imagePixels = await this.captureService.toRgbaPixels(imageCapture)
      const selectionPixels = await this.captureService.toSingleChannelPixels(selectionCapture)
      const previewBytes = new Uint8Array(imagePixels.length)

      for (let index = 0; index < selectionPixels.length; index += 1) {
        const offset = index * 4
        const selectionAlpha = selectionPixels[index]
        const sourceAlpha = imagePixels[offset + 3]
        previewBytes[offset] = imagePixels[offset]
        previewBytes[offset + 1] = imagePixels[offset + 1]
        previewBytes[offset + 2] = imagePixels[offset + 2]
        previewBytes[offset + 3] = preserveSourceAlpha
          ? Math.round((sourceAlpha * selectionAlpha) / 255)
          : selectionAlpha
      }

      return previewBytes
    }

    async exportApiSelectionCapture(doc, settings, { captureMode = 'merged', layerBoundaryMode = 'document' } = {}) {
      const selectionBounds = await this.getSelectionBounds(doc)
      if (!selectionBounds) {
        throw new Error('未能读取选区边界')
      }

      const documentBounds = this.getDocumentBounds(doc)
      let effectiveSelectionBounds = { ...selectionBounds }
      let sendLimitBounds = documentBounds

      if (captureMode === 'current') {
        const activeLayer = doc.activeLayers[0]
        if (!activeLayer) {
          throw new Error('当前没有活动图层')
        }

        const layerBounds = await this.getLayerBounds(activeLayer)
        if (!layerBounds) {
          throw new Error('当前图层没有可发送内容')
        }

        if (!this.boundsOverlap(selectionBounds, layerBounds)) {
          throw new Error('当前图层在选区内没有内容，请改用合并可见或更换图层')
        }

        if (layerBoundaryMode === 'content') {
          const croppedSelectionBounds = this.intersectBounds(selectionBounds, layerBounds)
          if (!croppedSelectionBounds) {
            throw new Error('当前图层在选区内没有内容，请改用合并可见或更换图层')
          }
          effectiveSelectionBounds = croppedSelectionBounds
          sendLimitBounds = layerBounds
        }
      }

      const selectionSendMode = settings.selectionSendMode === 'shape' ? 'shape' : 'rect'
      const selectionExpandPx = selectionSendMode === 'rect' ? this.normalizeExpandPx(settings.selectionExpandPx) : 0
      const sendBounds =
        selectionSendMode === 'rect'
          ? this.expandBounds(effectiveSelectionBounds, selectionExpandPx, sendLimitBounds)
          : { ...effectiveSelectionBounds }
      const targetSize = this.calculateTargetSize(sendBounds.width, sendBounds.height, settings)

      const image = await this.exportApiSelectionVariant(doc, settings, {
        captureMode,
        sendBounds,
        targetSize,
        selectionOnly: selectionSendMode === 'shape',
        fileStem: `selection_${selectionSendMode}_${Date.now()}`,
        forcedFormat: selectionSendMode === 'shape' || captureMode === 'current' ? 'png' : null,
      })

      const selectionMask =
        selectionSendMode === 'rect'
          ? await this.exportApiSelectionVariant(doc, settings, {
              captureMode,
              sendBounds,
              targetSize,
              selectionOnly: true,
              fileStem: `selection_mask_${Date.now()}`,
              forcedFormat: 'png',
            })
          : null

      return {
        image,
        selectionMask,
        meta: {
          source: captureMode === 'current' ? 'current_layer_selection' : 'merged_selection',
          document_name: doc.name,
          has_selection: true,
          original_bounds: effectiveSelectionBounds,
          send_bounds: sendBounds,
          selection_send_mode: selectionSendMode,
          selection_expand_px: selectionExpandPx,
          layer_boundary_mode: layerBoundaryMode,
          mask_in_image_alpha: selectionSendMode === 'shape',
        },
        placement: {
          canOverlayInPlace: true,
          isSelectionBased: true,
          selectionBounds: effectiveSelectionBounds,
          sendBounds,
          documentBounds,
          targetSize,
          selectionSendMode,
          selectionExpandPx,
        },
        parameters: this.buildParameters(settings),
      }
    }

    async exportApiCurrentLayerContent(doc, settings) {
      const activeLayer = doc.activeLayers[0]
      if (!activeLayer) {
        throw new Error('当前没有活动图层')
      }

      const layerBounds = await this.getLayerBounds(activeLayer)
      if (!layerBounds) {
        throw new Error('当前图层没有可发送内容')
      }

      const targetSize = this.calculateTargetSize(layerBounds.width, layerBounds.height, settings)
      const image = await this.performOperationWithHistorySuspension(doc, async () => {
        this.hideAllLayers(doc.layers)
        this.showLayer(activeLayer)
        await this.selectBounds(doc, layerBounds)
        await require('photoshop').action.batchPlay([{ _obj: 'crop' }], {})

        if (targetSize.width !== layerBounds.width || targetSize.height !== layerBounds.height) {
          await this.resizeDocument(doc, targetSize.width, targetSize.height)
        }

        return this.exportDocumentImage(doc, settings, `layer_content_${Date.now()}`, { forcedFormat: 'png' })
      })

      return {
        image,
        mask: null,
        meta: {
          source: 'current_layer_content',
          document_name: doc.name,
          has_selection: false,
          original_bounds: layerBounds,
        },
        placement: {
          canOverlayInPlace: true,
          isLayerPlacement: true,
          layerBounds,
          documentBounds: this.getDocumentBounds(doc),
          targetSize,
        },
        parameters: this.buildParameters(settings),
      }
    }

    async exportApiCurrentLayerDocument(doc, settings) {
      const activeLayer = doc.activeLayers[0]
      if (!activeLayer) {
        throw new Error('当前没有活动图层')
      }

      const docBounds = this.getDocumentBounds(doc)
      const targetSize = this.calculateTargetSize(docBounds.width, docBounds.height, settings)
      const image = await this.performOperationWithHistorySuspension(doc, async () => {
        this.hideAllLayers(doc.layers)
        this.showLayer(activeLayer)

        if (targetSize.width !== docBounds.width || targetSize.height !== docBounds.height) {
          await this.resizeDocument(doc, targetSize.width, targetSize.height)
        }

        return this.exportDocumentImage(doc, settings, `layer_document_${Date.now()}`, { forcedFormat: 'png' })
      })

      return {
        image,
        mask: null,
        meta: {
          source: 'current_layer_document',
          document_name: doc.name,
          has_selection: false,
          original_bounds: docBounds,
        },
        placement: {
          canOverlayInPlace: true,
          isLayerPlacement: true,
          layerBounds: docBounds,
          documentBounds: docBounds,
          targetSize,
        },
        parameters: this.buildParameters(settings),
      }
    }

    async exportApiMergedDocument(doc, settings) {
      const docBounds = this.getDocumentBounds(doc)
      const targetSize = this.calculateTargetSize(docBounds.width, docBounds.height, settings)
      const image = await this.performOperationWithHistorySuspension(doc, async () => {
        if (targetSize.width !== docBounds.width || targetSize.height !== docBounds.height) {
          await this.resizeDocument(doc, targetSize.width, targetSize.height)
        }

        return this.exportDocumentImage(doc, settings, `merged_${Date.now()}`)
      })

      return {
        image,
        mask: null,
        meta: {
          source: 'merged_document',
          document_name: doc.name,
          has_selection: false,
          original_bounds: docBounds,
        },
        placement: {
          canOverlayInPlace: true,
          documentBounds: docBounds,
          targetSize,
        },
        parameters: this.buildParameters(settings),
      }
    }

    async exportApiSelectionVariant(
      doc,
      settings,
      {
        captureMode = 'merged',
        sendBounds,
        targetSize,
        selectionOnly = false,
        fileStem = `selection_${Date.now()}`,
        forcedFormat = null,
      } = {},
    ) {
      return this.performOperationWithHistorySuspension(doc, async () => {
        await this.prepareVisibleLayersForCapture(doc, captureMode)
        await this.ensureNormalLayer(doc)
        await doc.mergeVisibleLayers()

        const mergedLayer = doc.activeLayers[0]
        if (selectionOnly && mergedLayer) {
          await this.clearOutsideSelection(doc, mergedLayer)
        }

        await this.selectBounds(doc, sendBounds)
        await require('photoshop').action.batchPlay([{ _obj: 'crop' }], {})

        if (targetSize.width !== sendBounds.width || targetSize.height !== sendBounds.height) {
          await this.resizeDocument(doc, targetSize.width, targetSize.height)
        }

        return this.exportDocumentImage(doc, settings, fileStem, { forcedFormat })
      })
    }

    buildRealtimeContextKey(snapshot = {}) {
      return JSON.stringify({
        docId: snapshot.docId || null,
        layerId: snapshot.layerId || null,
        captureMode: snapshot.captureMode || 'merged',
        layerBoundaryMode: snapshot.layerBoundaryMode || 'document',
        hasSelection: Boolean(snapshot.hasSelection),
        selectionSendMode: snapshot.selectionSendMode || 'rect',
        selectionExpandPx: Number(snapshot.selectionExpandPx || 0),
        sizeLimit: String(snapshot.sizeLimit || 'original'),
        customSizeValue: Number(snapshot.customSizeValue || 0),
        edgeControl: snapshot.edgeControl === 'short' ? 'short' : 'long',
        bounds: snapshot.bounds ? this.serializeBounds(snapshot.bounds) : null,
        selectionBounds: snapshot.selectionBounds ? this.serializeBounds(snapshot.selectionBounds) : null,
        sendBounds: snapshot.sendBounds ? this.serializeBounds(snapshot.sendBounds) : null,
        selectionSignature: snapshot.selectionSignature || '',
      })
    }

    serializeBounds(bounds) {
      return [
        Math.round(bounds.left || 0),
        Math.round(bounds.top || 0),
        Math.round(bounds.right || 0),
        Math.round(bounds.bottom || 0),
      ]
    }

    hashBytes(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) {
        return '0'
      }

      let hash = 2166136261
      for (let index = 0; index < bytes.length; index += 1) {
        hash ^= bytes[index]
        hash = Math.imul(hash, 16777619) >>> 0
      }
      return hash.toString(36)
    }

    hasVisiblePixels(rgbaPixels) {
      if (!(rgbaPixels instanceof Uint8Array)) {
        return false
      }

      for (let index = 3; index < rgbaPixels.length; index += 4) {
        if (rgbaPixels[index] > 0) {
          return true
        }
      }

      return false
    }

    buildParameters(settings = {}) {
      return {
        denoise: settings.denoise ?? 0.75,
        seed: settings.seed ?? -1,
        positive_prompt: settings.positivePrompt || '',
        negative_prompt: settings.negativePrompt || '',
        cfg_scale: settings.cfgScale ?? 7,
        steps: settings.steps ?? 20,
      }
    }

    async performOperationWithHistorySuspension(doc, operationCallback) {
      const photoshop = require('photoshop')

      return photoshop.core.executeAsModal(
        async (executionContext) => {
          const { hostControl } = executionContext
          let suspensionId = null

          try {
            suspensionId = await hostControl.suspendHistory({
              documentID: doc.id,
              name: '图南画桥导出',
            })

            const result = await operationCallback()
            await hostControl.resumeHistory(suspensionId, false)
            return result
          } catch (error) {
            if (suspensionId) {
              try {
                await hostControl.resumeHistory(suspensionId, false)
              } catch {}
            }
            throw error
          }
        },
        { commandName: '图南画桥导出' },
      )
    }

    async withTemporaryCurrentLayerDocument(sourceDoc, sourceLayer, options, operationCallback) {
      const photoshop = require('photoshop')

      return photoshop.core.executeAsModal(
        async () => {
          const tempDoc = await this.createTemporaryLayerDocument(sourceDoc, sourceLayer, options)

          try {
            return await operationCallback(tempDoc)
          } finally {
            await this.closeDocumentWithoutSaving(tempDoc)
          }
        },
        { commandName: '图南画桥导出' },
      )
    }

    getDocumentBounds(doc) {
      const width = this.toPixels(doc.width)
      const height = this.toPixels(doc.height)
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
      }
    }

    async createTemporaryLayerDocument(sourceDoc, sourceLayer, { canvasWidth, canvasHeight, offsetX = 0, offsetY = 0 } = {}) {
      const photoshop = require('photoshop')
      const { app } = photoshop
      const docBounds = this.getDocumentBounds(sourceDoc)
      const resolution = this.toPixels(sourceDoc.resolution) || 72

      const tempDoc = await app.createDocument({
        width: canvasWidth || docBounds.width,
        height: canvasHeight || docBounds.height,
        resolution,
        fill: 'transparent',
        mode: 'RGBColorMode',
        name: `Tunan Layer Export ${Date.now()}`,
      })

      await sourceDoc.duplicateLayers([sourceLayer], tempDoc)
      const duplicatedLayer = tempDoc.activeLayers[0]

      if (duplicatedLayer && (offsetX !== 0 || offsetY !== 0)) {
        await this.offsetLayer(duplicatedLayer, offsetX, offsetY)
      }

      return tempDoc
    }

    async closeDocumentWithoutSaving(doc) {
      if (!doc) return

      try {
        if (typeof doc.closeWithoutSaving === 'function') {
          await doc.closeWithoutSaving()
          return
        }
      } catch {}

      try {
        if (typeof doc.close === 'function') {
          await doc.close()
        }
      } catch {}
    }

    async ensureNormalLayer(doc) {
      if (!doc.backgroundLayer) return

      try {
        const backgroundLayer = doc.backgroundLayer
        const newLayer = await backgroundLayer.duplicate()
        newLayer.name = 'Layer 0'
        await backgroundLayer.delete()
      } catch {}
    }

    hideAllLayers(layers) {
      layers.forEach((layer) => {
        layer.visible = false
        if (layer.layers?.length) {
          this.hideAllLayers(layer.layers)
        }
      })
    }

    showLayer(layer) {
      const photoshop = require('photoshop')

      if (layer.kind === photoshop.constants.LayerKind.GROUP) {
        const showGroupContent = (group) => {
          group.visible = true
          if (group.layers?.length) {
            group.layers.forEach((subLayer) => {
              subLayer.visible = true
              if (subLayer.kind === photoshop.constants.LayerKind.GROUP) {
                showGroupContent(subLayer)
              }
            })
          }
        }

        showGroupContent(layer)
      } else {
        layer.visible = true
      }

      let parent = layer.parent
      while (parent) {
        try {
          if (Object.prototype.hasOwnProperty.call(parent, 'visible')) {
            parent.visible = true
          }
        } catch {}

        if (parent === photoshop.app.activeDocument) {
          break
        }

        parent = parent.parent
      }
    }

    checkVisibleLayers(layers) {
      return layers.some((layer) => {
        if (layer.visible) return true
        if (layer.layers?.length) return this.checkVisibleLayers(layer.layers)
        return false
      })
    }

    async prepareVisibleLayersForCapture(doc, captureMode = 'merged') {
      if (captureMode === 'current') {
        const activeLayer = doc.activeLayers[0]
        if (!activeLayer) {
          throw new Error('当前没有活动图层')
        }

        this.hideAllLayers(doc.layers)
        this.showLayer(activeLayer)
        return
      }

      if (!this.checkVisibleLayers(doc.layers)) {
        const activeLayer = doc.activeLayers[0]
        if (activeLayer) {
          this.showLayer(activeLayer)
        }
      }
    }

    async checkSelection(doc) {
      try {
        const photoshop = require('photoshop')
        const result = await photoshop.action.batchPlay(
          [
            {
              _obj: 'get',
              _target: [
                { _property: 'selection' },
                { _ref: 'document', _id: doc._id },
              ],
            },
          ],
          {},
        )

        return result[0]?.selection != null
      } catch {
        return false
      }
    }

    isQuickMaskMode(doc) {
      try {
        return !!doc?.quickMaskMode
      } catch {
        return false
      }
    }

    async getSelectionBounds(doc) {
      try {
        const docBounds = this.getDocumentBounds(doc)
        const tryCaptureBounds = async () => {
          const capture = await this.captureService.getSelectionPixelCapture(doc)
          const bounds = capture?.bounds
          this.captureService.disposeCapture(capture)
          return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null
        }

        if (this.isQuickMaskMode(doc)) {
          const quickMaskBounds = await tryCaptureBounds()
          if (quickMaskBounds) {
            return quickMaskBounds
          }
        }

        const photoshop = require('photoshop')
        const result = await photoshop.action.batchPlay(
          [
            {
              _obj: 'get',
              _target: [
                { _property: 'selection' },
                { _ref: 'document', _id: doc._id },
              ],
            },
          ],
          {},
        )

        const selection = result[0]?.selection
        if (!selection) return null

        const left = this.toPixels(selection.left)
        const top = this.toPixels(selection.top)
        const right = this.toPixels(selection.right)
        const bottom = this.toPixels(selection.bottom)

        if (![left, top, right, bottom].every(Number.isFinite)) {
          return await tryCaptureBounds()
        }

        const bounds = {
          left: Math.floor(left),
          top: Math.floor(top),
          right: Math.ceil(right),
          bottom: Math.ceil(bottom),
        }

        bounds.width = bounds.right - bounds.left
        bounds.height = bounds.bottom - bounds.top
        if (bounds.width <= 0 || bounds.height <= 0) {
          return null
        }

        const coversWholeDocument =
          docBounds &&
          bounds.left <= docBounds.left &&
          bounds.top <= docBounds.top &&
          bounds.right >= docBounds.right &&
          bounds.bottom >= docBounds.bottom

        if (!coversWholeDocument) {
          return bounds
        }

        const capturedBounds = await tryCaptureBounds()
        return capturedBounds || bounds
      } catch {
        try {
          const fallbackCapture = await this.captureService.getSelectionPixelCapture(doc)
          const fallbackBounds = fallbackCapture?.bounds
          this.captureService.disposeCapture(fallbackCapture)
          return fallbackBounds && fallbackBounds.width > 0 && fallbackBounds.height > 0
            ? fallbackBounds
            : null
        } catch {
          return null
        }
      }
    }

    async getLayerBounds(layer) {
      const domBounds = layer?.boundsNoEffects || layer?.bounds
      const normalizedDomBounds = this.normalizeDomBounds(domBounds)
      if (normalizedDomBounds) {
        return normalizedDomBounds
      }

      try {
        const photoshop = require('photoshop')
        const result = await photoshop.action.batchPlay(
          [
            {
              _obj: 'get',
              _target: [
                { _property: 'bounds' },
                { _ref: 'layer', _id: layer.id },
              ],
            },
          ],
          {},
        )

        const bounds = result[0]?.bounds
        if (!bounds) return null

        const layerBounds = {
          left: Math.floor(bounds.left._value || bounds.left),
          top: Math.floor(bounds.top._value || bounds.top),
          right: Math.ceil(bounds.right._value || bounds.right),
          bottom: Math.ceil(bounds.bottom._value || bounds.bottom),
        }

        layerBounds.width = layerBounds.right - layerBounds.left
        layerBounds.height = layerBounds.bottom - layerBounds.top
        return layerBounds.width > 0 && layerBounds.height > 0 ? layerBounds : null
      } catch {
        return null
      }
    }

    normalizeDomBounds(bounds) {
      if (!bounds || typeof bounds !== 'object') return null

      const left = this.toPixels(bounds.left)
      const top = this.toPixels(bounds.top)
      const right = this.toPixels(bounds.right)
      const bottom = this.toPixels(bounds.bottom)

      if (![left, top, right, bottom].every(Number.isFinite)) {
        return null
      }

      const normalizedBounds = {
        left: Math.floor(left),
        top: Math.floor(top),
        right: Math.ceil(right),
        bottom: Math.ceil(bottom),
      }

      normalizedBounds.width = normalizedBounds.right - normalizedBounds.left
      normalizedBounds.height = normalizedBounds.bottom - normalizedBounds.top
      return normalizedBounds.width > 0 && normalizedBounds.height > 0 ? normalizedBounds : null
    }

    async selectBounds(doc, bounds) {
      await require('photoshop').action.batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'channel', _property: 'selection' }],
            to: {
              _obj: 'rectangle',
              top: { _unit: 'pixelsUnit', _value: bounds.top },
              left: { _unit: 'pixelsUnit', _value: bounds.left },
              bottom: { _unit: 'pixelsUnit', _value: bounds.bottom },
              right: { _unit: 'pixelsUnit', _value: bounds.right },
            },
          },
        ],
        {},
      )
    }

    async clearOutsideSelection(doc, layer) {
      await doc.selection.inverse()
      await layer.clear()
      await doc.selection.inverse()
    }

    async offsetLayer(layer, offsetX, offsetY) {
      await require('photoshop').action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layer.id }],
            makeVisible: false,
          },
          {
            _obj: 'transform',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            freeTransformCenterState: {
              _enum: 'quadCenterState',
              _value: 'QCSAverage',
            },
            offset: {
              _obj: 'offset',
              horizontal: {
                _unit: 'pixelsUnit',
                _value: offsetX,
              },
              vertical: {
                _unit: 'pixelsUnit',
                _value: offsetY,
              },
            },
            linked: false,
          },
        ],
        {},
      )
    }

    normalizeExpandPx(value) {
      const nextValue = Number(value ?? 0)
      if (Number.isNaN(nextValue)) return 0
      return Math.max(0, Math.round(nextValue))
    }

    expandBounds(bounds, expandPx, limitBounds) {
      const nextBounds = {
        left: Math.max(limitBounds.left, bounds.left - expandPx),
        top: Math.max(limitBounds.top, bounds.top - expandPx),
        right: Math.min(limitBounds.right, bounds.right + expandPx),
        bottom: Math.min(limitBounds.bottom, bounds.bottom + expandPx),
      }

      nextBounds.width = Math.max(1, nextBounds.right - nextBounds.left)
      nextBounds.height = Math.max(1, nextBounds.bottom - nextBounds.top)
      return nextBounds
    }

    boundsOverlap(boundsA, boundsB) {
      if (!boundsA || !boundsB) return false

      return !(
        boundsA.right <= boundsB.left ||
        boundsA.left >= boundsB.right ||
        boundsA.bottom <= boundsB.top ||
        boundsA.top >= boundsB.bottom
      )
    }

    intersectBounds(boundsA, boundsB) {
      if (!this.boundsOverlap(boundsA, boundsB)) {
        return null
      }

      const nextBounds = {
        left: Math.max(boundsA.left, boundsB.left),
        top: Math.max(boundsA.top, boundsB.top),
        right: Math.min(boundsA.right, boundsB.right),
        bottom: Math.min(boundsA.bottom, boundsB.bottom),
      }

      nextBounds.width = Math.max(0, nextBounds.right - nextBounds.left)
      nextBounds.height = Math.max(0, nextBounds.bottom - nextBounds.top)
      return nextBounds.width > 0 && nextBounds.height > 0 ? nextBounds : null
    }

    calculateTargetSize(sourceWidth, sourceHeight, settings = {}) {
      const sizeLimit = settings.sizeLimit || 'original'
      if (sizeLimit === 'original') {
        return {
          width: sourceWidth,
          height: sourceHeight,
        }
      }

      const targetEdge =
        sizeLimit === 'custom' ? Number(settings.customSizeValue || sourceWidth) : Number(sizeLimit)

      if (!targetEdge || Number.isNaN(targetEdge)) {
        return {
          width: sourceWidth,
          height: sourceHeight,
        }
      }

      const edgeControl = settings.edgeControl === 'short' ? 'short' : 'long'
      const currentEdge = edgeControl === 'short' ? Math.min(sourceWidth, sourceHeight) : Math.max(sourceWidth, sourceHeight)

      if (!currentEdge || currentEdge <= 0) {
        return {
          width: sourceWidth,
          height: sourceHeight,
        }
      }

      const scale = targetEdge / currentEdge
      return {
        width: this.alignToEight(Math.max(8, Math.round(sourceWidth * scale))),
        height: this.alignToEight(Math.max(8, Math.round(sourceHeight * scale))),
      }
    }

    alignToEight(value) {
      return Math.max(8, Math.round(value / 8) * 8)
    }

    async resizeDocument(doc, targetWidth, targetHeight) {
      await require('photoshop').action.batchPlay(
        [
          {
            _obj: 'imageSize',
            _target: [{ _ref: 'document', _id: doc._id }],
            width: { _unit: 'pixelsUnit', _value: Math.round(targetWidth) },
            height: { _unit: 'pixelsUnit', _value: Math.round(targetHeight) },
            resolution: { _unit: 'densityUnit', _value: 72 },
            resampleMethod: {
              _enum: 'interpolationType',
              _value: 'bicubicSharper',
            },
            constrainProportions: false,
          },
        ],
        {},
      )
    }

    async exportDocumentImage(doc, settings, fileStem, options = {}) {
      const uxp = require('uxp')
      const fs = uxp.storage.localFileSystem
      const tempFolder = await fs.getTemporaryFolder()
      const format = options.forcedFormat || (settings.imageFormat === 'jpg' ? 'jpg' : 'png')
      const file = await tempFolder.createFile(`${fileStem}.${format}`, { overwrite: true })

      if (format === 'jpg') {
        await doc.saveAs.jpg(
          file,
          {
            quality: Number(settings.jpegQuality || 90),
            embedColorProfile: true,
          },
          true,
        )
      } else {
        await doc.saveAs.png(
          file,
          {
            compression: 6,
            interlaceScheme: 'interlaceNone',
          },
          true,
        )
      }

      const buffer = await file.read({ format: uxp.storage.formats.binary })
      const dataUrl = this.arrayBufferToDataUrl(buffer, format === 'jpg' ? 'image/jpeg' : 'image/png')

      try {
        await file.delete()
      } catch {}

      return {
        data: dataUrl,
        format,
        width: this.toPixels(doc.width),
        height: this.toPixels(doc.height),
        name: `${fileStem}.${format}`,
      }
    }

    arrayBufferToDataUrl(buffer, mimeType) {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunkSize = 0x8000

      for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length))
        binary += String.fromCharCode.apply(null, chunk)
      }

      return `data:${mimeType};base64,${btoa(binary)}`
    }

    toPixels(value) {
      if (typeof value === 'number') return value
      if (value && typeof value === 'object' && 'value' in value) return Number(value.value)
      if (value && typeof value === 'object' && '_value' in value) return Number(value._value)
      return Number(value || 0)
    }

    resolveReturnLayerType(settings = {}) {
      if (settings.returnLayerType === 'pixelLayer') {
        return 'pixelLayer'
      }

      return 'smartObject'
    }

    resolveReturnLayerNaming(settings = {}) {
      if (settings.returnLayerNaming === 'sequence' || settings.returnLayerNaming === 'time') {
        return settings.returnLayerNaming
      }

      return 'source'
    }

    sanitizeLayerName(name) {
      const nextName = String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()

      return nextName.slice(0, 120)
    }

    collectLayerNames(layers = [], bucket = []) {
      for (const layer of layers || []) {
        if (layer?.name) {
          bucket.push(String(layer.name))
        }

        if (Array.isArray(layer?.layers) && layer.layers.length) {
          this.collectLayerNames(layer.layers, bucket)
        }
      }

      return bucket
    }

    ensureUniqueLayerName(doc, proposedName) {
      const baseName = this.sanitizeLayerName(proposedName) || '细化'
      const existingNames = new Set(this.collectLayerNames(doc?.layers || []))
      if (!existingNames.has(baseName)) {
        return baseName
      }

      for (let index = 2; index < 1000; index += 1) {
        const nextName = `${baseName} ${index}`
        if (!existingNames.has(nextName)) {
          return nextName
        }
      }

      return `${baseName} ${Date.now()}`
    }

    buildSequentialLayerName(doc) {
      const existingNames = new Set(this.collectLayerNames(doc?.layers || []))
      for (let index = 1; index < 1000; index += 1) {
        const candidate = `细化_${String(index).padStart(2, '0')}`
        if (!existingNames.has(candidate)) {
          return candidate
        }
      }
      return `细化_${Date.now()}`
    }

    buildTimeLayerName() {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      return `细化_${month}${day}_${hours}${minutes}`
    }

    buildSourceLayerName(sourceLayerName) {
      const baseName = this.sanitizeLayerName(sourceLayerName)
      if (!baseName) return ''
      if (baseName.endsWith('_细化') || baseName.endsWith(' 细化')) {
        return baseName
      }
      return `${baseName}_细化`
    }

    resolveReturnLayerName(doc, meta = {}, settings = {}) {
      const namingMode = this.resolveReturnLayerNaming(settings)
      const sourceLayerName = meta?.sourceLayerName || meta?.source_layer_name || ''

      if (namingMode === 'source') {
        const fromSource = this.buildSourceLayerName(sourceLayerName)
        if (fromSource) {
          return this.ensureUniqueLayerName(doc, fromSource)
        }
      }

      if (namingMode === 'time') {
        return this.ensureUniqueLayerName(doc, this.buildTimeLayerName())
      }

      return this.buildSequentialLayerName(doc)
    }

    async rasterizeLayer(layer) {
      if (!layer) return

      const photoshop = require('photoshop')

      if (typeof layer.rasterize === 'function') {
        const rasterizeType = photoshop.constants?.RasterizeType?.ENTIRELAYER
        if (rasterizeType) {
          await layer.rasterize(rasterizeType)
          return
        }
      }

      await photoshop.action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layer.id }],
            makeVisible: false,
          },
          {
            _obj: 'rasterizeLayer',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            what: {
              _enum: 'rasterizeItem',
              _value: 'placed',
            },
          },
        ],
        {},
      )
    }

    async placeFileAsSmartObject(token) {
      const { action } = require('photoshop')

      await action.batchPlay(
        [
          {
            _obj: 'placeEvent',
            null: {
              _path: token,
              _kind: 'local',
            },
            linked: false,
            _options: {
              dialogOptions: 'dontDisplay',
            },
          },
        ],
        {},
      )
    }

    async convertLayerToSmartObject(layer) {
      if (!layer) return layer

      const { action, app } = require('photoshop')

      await action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layer.id }],
            makeVisible: false,
          },
          {
            _obj: 'newPlacedLayer',
          },
        ],
        {},
      )

      return app.activeDocument?.activeLayers?.[0] || layer
    }

    async importImageViaDocumentFallback(fileEntry, targetDoc, targetLayerType = 'smartObject') {
      const { app } = require('photoshop')
      let importDoc = null

      try {
        importDoc = await app.open(fileEntry)
        await this.ensureNormalLayer(importDoc)

        const sourceLayer = importDoc.activeLayers?.[0] || importDoc.layers?.[0] || null
        if (!sourceLayer) {
          throw new Error('备用导入时未找到可复制图层')
        }

        await importDoc.duplicateLayers([sourceLayer], targetDoc)

        let placedLayer = targetDoc.activeLayers?.[0] || null
        if (!placedLayer) {
          throw new Error('备用导入后未找到目标图层')
        }

        if (targetLayerType === 'smartObject') {
          placedLayer = await this.convertLayerToSmartObject(placedLayer)
        }

        return placedLayer
      } finally {
        await this.closeDocumentWithoutSaving(importDoc)
      }
    }

    buildPhotoshopImportError(stageLabel, error) {
      const rawMessage = error?.message || String(error || '')
      const code = error?.number ?? error?.code ?? error?.result ?? null
      const suffix = code != null ? ` (${code})` : ''
      return new Error(`${stageLabel}失败${suffix}: ${rawMessage}`)
    }

    isSmartObjectUpdateError(error) {
      const rawMessage = String(error?.message || error || '')
      const code = error?.number ?? error?.code ?? error?.result ?? null
      return (
        code === -25010 ||
        rawMessage.includes('-25010') ||
        rawMessage.includes('无法更新智能对象文件')
      )
    }

    async addImageToDocument(payload = {}) {
      const imageData = payload.image
      if (!imageData) {
        throw new Error('没有可导回 Photoshop 的图像')
      }

      const returnSettings = payload.settings || {}
      const placement = payload.placement || payload.meta?.placement || null
      const imageInfo = {
        image: imageData,
        placement,
        name: '',
      }

      return require('photoshop').core.executeAsModal(
        async () => {
          const { app, action } = require('photoshop')
          const uxp = require('uxp')
          const fs = uxp.storage.localFileSystem

          let doc = app.activeDocument
          if (!doc) {
            doc = await app.createDocument({
              width: 1024,
              height: 1024,
              resolution: 72,
              fill: 'transparent',
              mode: 'RGBColorMode',
              name: '细化结果',
            })
          }

          const targetLayerType = this.resolveReturnLayerType(returnSettings)
          imageInfo.name = this.resolveReturnLayerName(doc, payload.meta || {}, returnSettings)

          const tempFolder = await fs.getTemporaryFolder()
          const extension = imageData.includes('image/jpeg') ? 'jpg' : 'png'
          const tempFile = await tempFolder.createFile(`tunan_return_${Date.now()}.${extension}`, {
            overwrite: true,
          })
          await tempFile.write(this.dataUrlToArrayBuffer(imageData))

          const token = await fs.createSessionToken(tempFile)
          void token

          let placedLayer = null
          let importError = null
          let degradedToPixelLayer = false

          try {
            placedLayer = await this.importImageViaDocumentFallback(
              tempFile,
              doc,
              targetLayerType,
            )
          } catch (error) {
            importError = error
          }

          if (!placedLayer && targetLayerType === 'smartObject') {
            try {
              placedLayer = await this.importImageViaDocumentFallback(
                tempFile,
                doc,
                'pixelLayer',
              )
              degradedToPixelLayer = true
            } catch (pixelFallbackError) {
              if (importError) {
                const primaryMessage = this.buildPhotoshopImportError('智能对象导入', importError).message
                const fallbackMessage = this.buildPhotoshopImportError('像素图层备用导入', pixelFallbackError).message
                throw new Error(primaryMessage + '; ' + fallbackMessage)
              }
              throw this.buildPhotoshopImportError('像素图层备用导入', pixelFallbackError)
            }
          }

          if (!placedLayer && importError) {
            throw this.buildPhotoshopImportError('备用导入', importError)
          }

          if (placedLayer) {
            const currentBounds = await this.getLayerBounds(placedLayer)
            const targetBounds = this.resolvePlacementTargetBounds(
              placement,
              payload.meta || {},
            )
            const effectiveCurrentBounds = this.resolvePlacedCanvasBounds(
              currentBounds,
              payload.meta || {},
            )

            if (effectiveCurrentBounds && targetBounds) {
              await this.transformLayer(placedLayer, effectiveCurrentBounds, targetBounds)
            }

            if (targetLayerType === 'pixelLayer') {
              await this.rasterizeLayer(placedLayer)
              placedLayer = doc.activeLayers[0] || placedLayer
            }

            placedLayer.name = imageInfo.name
          }

          try {
            await tempFile.delete()
          } catch {}

          return {
            supported: true,
            placed: true,
            name: imageInfo.name,
            layerType: degradedToPixelLayer ? 'pixelLayer' : targetLayerType,
            degradedToPixelLayer,
          }
        },
        { commandName: '图南画桥发送回 Photoshop' },
      )
    }

    async transformLayer(layer, currentBounds, targetBounds) {
      const { action } = require('photoshop')

      const currentCenterX = currentBounds.left + currentBounds.width / 2
      const currentCenterY = currentBounds.top + currentBounds.height / 2
      const targetCenterX = targetBounds.left + targetBounds.width / 2
      const targetCenterY = targetBounds.top + targetBounds.height / 2

      const scaleX = (targetBounds.width / currentBounds.width) * 100
      const scaleY = (targetBounds.height / currentBounds.height) * 100
      const deltaX = targetCenterX - currentCenterX
      const deltaY = targetCenterY - currentCenterY

      await action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layer.id }],
            makeVisible: false,
          },
          {
            _obj: 'transform',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            freeTransformCenterState: {
              _enum: 'quadCenterState',
              _value: 'QCSAverage',
            },
            offset: {
              _obj: 'offset',
              horizontal: {
                _unit: 'pixelsUnit',
                _value: deltaX,
              },
              vertical: {
                _unit: 'pixelsUnit',
                _value: deltaY,
              },
            },
            width: {
              _unit: 'percentUnit',
              _value: scaleX,
            },
            height: {
              _unit: 'percentUnit',
              _value: scaleY,
            },
            linked: false,
          },
        ],
        {},
      )
    }

    resolvePlacementTargetBounds(placement = null, meta = {}) {
      if (!placement || typeof placement !== 'object') return null

      const canvasRole = String(placement.canvasRole || meta.canvasRole || '')
        .trim()
        .toLowerCase()

      if (canvasRole === 'selection') {
        return (
          placement.selectionBounds ||
          placement.sendBounds ||
          placement.layerBounds ||
          placement.documentBounds ||
          placement.selectionReturnBounds ||
          null
        )
      }

      return (
        placement.sendBounds ||
        placement.selectionBounds ||
        placement.layerBounds ||
        placement.documentBounds ||
        placement.selectionReturnBounds ||
        null
      )
    }

    inferPlacedCanvasBounds(currentVisibleBounds, meta = {}) {
      if (!currentVisibleBounds) return null

      const imageWidth = Number(meta.imageWidth || 0)
      const imageHeight = Number(meta.imageHeight || 0)
      const visibleBounds = meta.visibleBounds || null

      if (
        !imageWidth ||
        !imageHeight ||
        !visibleBounds ||
        !Number.isFinite(visibleBounds.left) ||
        !Number.isFinite(visibleBounds.top) ||
        !Number.isFinite(visibleBounds.right) ||
        !Number.isFinite(visibleBounds.bottom)
      ) {
        return currentVisibleBounds
      }

      const visibleWidth = Number(visibleBounds.width || (visibleBounds.right - visibleBounds.left) || 0)
      const visibleHeight = Number(visibleBounds.height || (visibleBounds.bottom - visibleBounds.top) || 0)

      if (visibleWidth <= 0 || visibleHeight <= 0) {
        return currentVisibleBounds
      }

      const scaleX = currentVisibleBounds.width / visibleWidth
      const scaleY = currentVisibleBounds.height / visibleHeight

      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
        return currentVisibleBounds
      }

      const fullLeft = currentVisibleBounds.left - visibleBounds.left * scaleX
      const fullTop = currentVisibleBounds.top - visibleBounds.top * scaleY
      const fullRight = fullLeft + imageWidth * scaleX
      const fullBottom = fullTop + imageHeight * scaleY

      const fullBounds = {
        left: fullLeft,
        top: fullTop,
        right: fullRight,
        bottom: fullBottom,
        width: fullRight - fullLeft,
        height: fullBottom - fullTop,
      }

      if (
        !Number.isFinite(fullBounds.left) ||
        !Number.isFinite(fullBounds.top) ||
        !Number.isFinite(fullBounds.right) ||
        !Number.isFinite(fullBounds.bottom) ||
        fullBounds.width <= 0 ||
        fullBounds.height <= 0
      ) {
        return currentVisibleBounds
      }

      return fullBounds
    }

    resolvePlacedCanvasBounds(currentBounds, meta = {}) {
      if (!currentBounds) return null

      const imageWidth = Number(meta.imageWidth || 0)
      const imageHeight = Number(meta.imageHeight || 0)
      const visibleBounds = meta.visibleBounds || null
      const visibleWidth = Number(visibleBounds?.width || (visibleBounds?.right - visibleBounds?.left) || 0)
      const visibleHeight = Number(visibleBounds?.height || (visibleBounds?.bottom - visibleBounds?.top) || 0)

      if (
        imageWidth <= 0 ||
        imageHeight <= 0 ||
        visibleWidth <= 0 ||
        visibleHeight <= 0 ||
        currentBounds.width <= 0 ||
        currentBounds.height <= 0
      ) {
        return currentBounds
      }

      const fullScaleX = currentBounds.width / imageWidth
      const fullScaleY = currentBounds.height / imageHeight
      const visibleScaleX = currentBounds.width / visibleWidth
      const visibleScaleY = currentBounds.height / visibleHeight

      const fullDelta = Math.abs(fullScaleX - fullScaleY)
      const visibleDelta = Math.abs(visibleScaleX - visibleScaleY)

      if (
        Number.isFinite(fullDelta) &&
        Number.isFinite(visibleDelta) &&
        fullDelta <= visibleDelta
      ) {
        return currentBounds
      }

      return this.inferPlacedCanvasBounds(currentBounds, meta)
    }

    dataUrlToArrayBuffer(dataUrl) {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }

      return bytes.buffer
    }
  }

  global.TunanPhotoshopService = TunanPhotoshopService
})(window)

