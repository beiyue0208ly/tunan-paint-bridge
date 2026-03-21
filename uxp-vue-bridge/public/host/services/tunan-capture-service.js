(function initTunanCaptureService(global) {
  const debugSelection = (...args) => {
    void args
  }

  class TunanCaptureService {
    constructor(photoshopService) {
      this.ps = photoshopService
    }

    async collectActiveContext(settings = {}) {
      const photoshop = require('photoshop')
      const doc = photoshop.app.activeDocument

      if (!doc) {
        throw new Error('请先在 Photoshop 中打开一个文档')
      }

      const captureMode = settings.captureMode || 'merged'
      const layerBoundaryMode = settings.layerBoundaryMode || 'document'
      const useSelection = settings.useSelection !== false
      const hasSelection = useSelection
        ? (this.ps.isQuickMaskMode(doc) || await this.ps.checkSelection(doc))
        : false

      if (hasSelection) {
        return this.exportSelectionCapture(doc, settings, {
          captureMode,
          layerBoundaryMode,
        })
      }

      if (captureMode === 'current') {
        return layerBoundaryMode === 'content'
          ? this.exportCurrentLayerContent(doc, settings)
          : this.exportCurrentLayerDocument(doc, settings)
      }

      return this.exportMergedDocument(doc, settings)
    }

    async runModalOperation(commandName, callback) {
      const photoshop = require('photoshop')
      return photoshop.core.executeAsModal(async () => callback(), { commandName })
    }

    async exportCurrentLayerContent(doc, settings) {
      return this.runModalOperation('图南画桥导出', async () => {
        const activeLayer = doc.activeLayers?.[0]
        if (!activeLayer) {
          throw new Error('当前没有活动图层')
        }

        const pixelCapture = await this.getLayerPixelCapture(doc, activeLayer)
        const visibleBounds = pixelCapture.bounds
        if (!visibleBounds || visibleBounds.width <= 0 || visibleBounds.height <= 0) {
          this.disposeCapture(pixelCapture)
          throw new Error('当前图层没有可发送内容')
        }

        const targetSize = this.ps.calculateTargetSize(visibleBounds.width, visibleBounds.height, settings)

        try {
          const image = await this.buildCapturePayload(pixelCapture, {
            name: `layer_content_${Date.now()}.raw`,
            canvasBounds: visibleBounds,
            targetSize,
            outputFormat: 'png',
          })

          return {
            image,
            mask: null,
            selectionMask: null,
            contentAlpha: null,
            meta: {
              source: 'current_layer_content',
              document_name: doc.name,
              source_layer_name: activeLayer.name || '',
              has_selection: false,
              original_bounds: visibleBounds,
            },
            placement: {
              canOverlayInPlace: true,
              isLayerPlacement: true,
              layerBounds: visibleBounds,
              documentBounds: this.ps.getDocumentBounds(doc),
              targetSize,
            },
            parameters: this.ps.buildParameters(settings),
          }
        } finally {
          this.disposeCapture(pixelCapture)
        }
      })
    }

    async exportCurrentLayerDocument(doc, settings) {
      return this.runModalOperation('图南画桥导出', async () => {
        const activeLayer = doc.activeLayers?.[0]
        if (!activeLayer) {
          throw new Error('当前没有活动图层')
        }

        const docBounds = this.ps.getDocumentBounds(doc)
        const targetSize = this.ps.calculateTargetSize(docBounds.width, docBounds.height, settings)
        const pixelCapture = await this.getLayerPixelCapture(doc, activeLayer, {
          sourceBounds: docBounds,
          fallbackBounds: docBounds,
        })

        try {
          const image = await this.buildCapturePayload(pixelCapture, {
            name: `layer_document_${Date.now()}.raw`,
            canvasBounds: docBounds,
            targetSize,
            outputFormat: 'png',
          })

          return {
            image,
            mask: null,
            selectionMask: null,
            contentAlpha: null,
            meta: {
              source: 'current_layer_document',
              document_name: doc.name,
              source_layer_name: activeLayer.name || '',
              has_selection: false,
              original_bounds: docBounds,
              content_bounds: pixelCapture.bounds,
            },
            placement: {
              canOverlayInPlace: true,
              isLayerPlacement: true,
              layerBounds: docBounds,
              documentBounds: docBounds,
              contentBounds: pixelCapture.bounds,
              targetSize,
            },
            parameters: this.ps.buildParameters(settings),
          }
        } finally {
          this.disposeCapture(pixelCapture)
        }
      })
    }

    async exportMergedDocument(doc, settings) {
      return this.runModalOperation('图南画桥导出', async () => {
        const docBounds = this.ps.getDocumentBounds(doc)
        const targetSize = this.ps.calculateTargetSize(docBounds.width, docBounds.height, settings)
        const pixelCapture = await this.getDocumentPixelCapture(doc, { sourceBounds: docBounds })

        try {
          const image = await this.buildCapturePayload(pixelCapture, {
            name: `merged_${Date.now()}.raw`,
            canvasBounds: docBounds,
            targetSize,
            outputFormat: settings.imageFormat === 'jpg' ? 'jpg' : 'png',
            jpegQuality: Number(settings.jpegQuality || 90),
          })

          return {
            image,
            mask: null,
            selectionMask: null,
            contentAlpha: null,
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
            parameters: this.ps.buildParameters(settings),
          }
        } finally {
          this.disposeCapture(pixelCapture)
        }
      })
    }

    async exportSelectionCapture(doc, settings, { captureMode = 'merged', layerBoundaryMode = 'document' } = {}) {
      return this.runModalOperation('图南画桥导出', async () => {
        const docBounds = this.ps.getDocumentBounds(doc)
        const selectionBoundsCapture = await this.getSelectionPixelCapture(doc)
        const selectionBounds = selectionBoundsCapture?.bounds
        const selectionPolarity = selectionBoundsCapture?.selectionPolarity || 'high'
        this.disposeCapture(selectionBoundsCapture)

        if (!selectionBounds || selectionBounds.width <= 0 || selectionBounds.height <= 0) {
          throw new Error('未能读取选区边界')
        }

        let effectiveSelectionBounds = { ...selectionBounds }
        let sendLimitBounds = docBounds
        let activeLayer = null

        if (captureMode === 'current') {
          activeLayer = doc.activeLayers?.[0]
          if (!activeLayer) {
            throw new Error('当前没有活动图层')
          }

          const layerContentCapture = await this.getLayerPixelCapture(doc, activeLayer, {
            fallbackBounds: docBounds,
          })
          const layerBounds = layerContentCapture.bounds
          this.disposeCapture(layerContentCapture)

          if (!layerBounds || layerBounds.width <= 0 || layerBounds.height <= 0) {
            throw new Error('当前图层没有可发送内容')
          }

          if (!this.ps.boundsOverlap(selectionBounds, layerBounds)) {
            throw new Error('当前图层在选区内没有内容，请改用合并可见或更换图层')
          }

          if (layerBoundaryMode === 'content') {
            const croppedSelectionBounds = this.ps.intersectBounds(selectionBounds, layerBounds)
            if (!croppedSelectionBounds) {
              throw new Error('当前图层在选区内没有内容，请改用合并可见或更换图层')
            }
            effectiveSelectionBounds = croppedSelectionBounds
            sendLimitBounds = layerBounds
          }
        }

        const selectionSendMode = settings.selectionSendMode === 'shape' ? 'shape' : 'rect'
        const selectionExpandPx = selectionSendMode === 'rect'
          ? this.ps.normalizeExpandPx(settings.selectionExpandPx)
          : 0
        const sendBounds = selectionSendMode === 'rect'
          ? this.ps.expandBounds(effectiveSelectionBounds, selectionExpandPx, sendLimitBounds)
          : { ...effectiveSelectionBounds }
        const targetSize = this.ps.calculateTargetSize(sendBounds.width, sendBounds.height, settings)

        const selectionMaskCapture = await this.getSelectionPixelCapture(doc, {
          sourceBounds: sendBounds,
          expectedBounds: effectiveSelectionBounds,
          expectedPolarity: selectionPolarity,
        })
        if (!selectionMaskCapture?.bounds || selectionMaskCapture.bounds.width <= 0 || selectionMaskCapture.bounds.height <= 0) {
          this.disposeCapture(selectionMaskCapture)
          throw new Error('选区内没有可发送内容')
        }

        let imageCapture
        let image
        let contentAlpha = null

        try {
          if (captureMode === 'current') {
            imageCapture = await this.getLayerPixelCapture(doc, activeLayer, {
              sourceBounds: sendBounds,
              fallbackBounds: sendBounds,
            })

            if (!imageCapture?.bounds || imageCapture.bounds.width <= 0 || imageCapture.bounds.height <= 0) {
              throw new Error('当前图层在选区内没有内容，请改用合并可见或更换图层')
            }

            contentAlpha = await this.buildAlphaPayload(imageCapture, {
              name: `content_alpha_${Date.now()}.raw`,
              canvasBounds: sendBounds,
              targetSize,
            })

            if (selectionSendMode === 'shape') {
              image = await this.buildMaskedImagePayload(imageCapture, selectionMaskCapture, {
                name: `selection_shape_${Date.now()}.raw`,
                canvasBounds: sendBounds,
                targetSize,
                preserveSourceAlpha: true,
              })
            } else {
              image = await this.buildCapturePayload(imageCapture, {
                name: `selection_rect_${Date.now()}.raw`,
                canvasBounds: sendBounds,
                targetSize,
                outputFormat: 'png',
              })
            }
          } else {
            imageCapture = await this.getDocumentPixelCapture(doc, { sourceBounds: sendBounds })

            if (selectionSendMode === 'shape') {
              image = await this.buildMaskedImagePayload(imageCapture, selectionMaskCapture, {
                name: `selection_shape_${Date.now()}.raw`,
                canvasBounds: sendBounds,
                targetSize,
                preserveSourceAlpha: false,
              })
            } else {
              image = await this.buildCapturePayload(imageCapture, {
                name: `selection_rect_${Date.now()}.raw`,
                canvasBounds: sendBounds,
                targetSize,
                outputFormat: settings.imageFormat === 'jpg' ? 'jpg' : 'png',
                jpegQuality: Number(settings.jpegQuality || 90),
              })
            }
          }

          debugSelection('exportSelectionCapture', {
            quickMaskMode: this.ps.isQuickMaskMode(doc),
            captureMode,
            layerBoundaryMode,
            selectionSendMode,
            selectionExpandPx,
            selectionBounds,
            effectiveSelectionBounds,
            sendBounds,
            selectionMaskBounds: selectionMaskCapture?.bounds || null,
            selectionMaskComponents: selectionMaskCapture?.components || null,
            imageBounds: imageCapture?.bounds || null,
            imageComponents: imageCapture?.components || null,
          })

          const selectionMask = await this.buildMaskPayload(selectionMaskCapture, {
            name: `selection_mask_${Date.now()}.raw`,
            canvasBounds: sendBounds,
            targetSize,
          })

          return {
            image,
            mask: null,
            selectionMask,
            contentAlpha,
            meta: {
              source: captureMode === 'current' ? 'current_layer_selection' : 'merged_selection',
              document_name: doc.name,
              source_layer_name: captureMode === 'current' ? (activeLayer?.name || '') : '',
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
              documentBounds: docBounds,
              targetSize,
              selectionSendMode,
              selectionExpandPx,
            },
            parameters: this.ps.buildParameters(settings),
          }
        } finally {
          this.disposeCapture(imageCapture)
          this.disposeCapture(selectionMaskCapture)
        }
      })
    }

    async getLayerPixelCapture(doc, layer, options = {}) {
      const photoshop = require('photoshop')
      const requestBounds = await this.resolveRequestBounds(layer, options)
      const request = {
        documentID: doc.id ?? doc._id,
        layerID: layer.id,
        colorSpace: 'RGB',
        componentSize: 8,
      }

      if (requestBounds) {
        request.sourceBounds = this.toSourceBounds(requestBounds)
      }

      if (options.targetSize?.width && options.targetSize?.height) {
        request.targetSize = {
          width: Math.max(1, Math.round(options.targetSize.width)),
          height: Math.max(1, Math.round(options.targetSize.height)),
        }
      }

      const imageObj = await this.getPixelsWithoutQuickMask(doc, request)

      return {
        imageData: imageObj.imageData,
        components: imageObj.imageData.components,
        bounds: this.normalizeImagingBounds(
          imageObj.sourceBounds,
          imageObj.imageData.width,
          imageObj.imageData.height,
        ),
      }
    }

    async getDocumentPixelCapture(doc, options = {}) {
      const photoshop = require('photoshop')
      const requestBounds = options.sourceBounds || this.ps.getDocumentBounds(doc)
      const request = {
        documentID: doc.id ?? doc._id,
        sourceBounds: this.toSourceBounds(requestBounds),
        colorSpace: 'RGB',
        componentSize: 8,
      }

      if (options.targetSize?.width && options.targetSize?.height) {
        request.targetSize = {
          width: Math.max(1, Math.round(options.targetSize.width)),
          height: Math.max(1, Math.round(options.targetSize.height)),
        }
      }

      const imageObj = await this.getPixelsWithoutQuickMask(doc, request)

      return {
        imageData: imageObj.imageData,
        components: imageObj.imageData.components,
        bounds: this.normalizeImagingBounds(
          imageObj.sourceBounds,
          imageObj.imageData.width,
          imageObj.imageData.height,
        ),
      }
    }

    async getSelectionPixelCapture(doc, options = {}) {
      const photoshop = require('photoshop')
      const request = {
        documentID: doc.id ?? doc._id,
        componentSize: 8,
      }

      if (options.sourceBounds) {
        request.sourceBounds = this.toSourceBounds(options.sourceBounds)
      }

      if (options.targetSize?.width && options.targetSize?.height) {
        request.targetSize = {
          width: Math.max(1, Math.round(options.targetSize.width)),
          height: Math.max(1, Math.round(options.targetSize.height)),
        }
      }

      const selectionObj = await photoshop.imaging.getSelection(request)
      if (!selectionObj?.imageData) {
        return null
      }

      const capture = {
        imageData: selectionObj.imageData,
        components: selectionObj.imageData.components,
        bounds: this.normalizeImagingBounds(
          selectionObj.sourceBounds,
          selectionObj.imageData.width,
          selectionObj.imageData.height,
        ),
      }

      const positiveBounds = await this.computeSingleChannelContentBounds(capture, { polarity: 'high' })
      const negativeBounds = await this.computeSingleChannelContentBounds(capture, { polarity: 'low' })
      let resolvedSelection = this.resolveSelectionCandidateBounds({
        rawBounds: capture.bounds,
        positiveBounds,
        negativeBounds,
        expectedBounds: options.expectedBounds || null,
      })
      if (options.expectedPolarity === 'high' || options.expectedPolarity === 'low') {
        const hintedBounds = options.expectedPolarity === 'low' ? negativeBounds : positiveBounds
        if (hintedBounds && hintedBounds.width > 0 && hintedBounds.height > 0) {
          resolvedSelection = {
            polarity: options.expectedPolarity,
            bounds: hintedBounds,
          }
        }
      }
      debugSelection('getSelectionPixelCapture', {
        quickMaskMode: this.ps.isQuickMaskMode(doc),
        requestedSourceBounds: options.sourceBounds || null,
        rawBounds: capture.bounds,
        positiveBounds: positiveBounds || null,
        negativeBounds: negativeBounds || null,
        resolvedBounds: resolvedSelection.bounds || null,
        resolvedPolarity: resolvedSelection.polarity,
        expectedPolarity: options.expectedPolarity || null,
        components: capture.components,
        width: capture.imageData.width,
        height: capture.imageData.height,
      })
      capture.selectionPolarity = resolvedSelection.polarity
      capture.bounds = resolvedSelection.bounds || {
        left: capture.bounds.left,
        top: capture.bounds.top,
        right: capture.bounds.left,
        bottom: capture.bounds.top,
        width: 0,
        height: 0,
      }

      return capture
    }

    async getPixelsWithoutQuickMask(doc, request) {
      const photoshop = require('photoshop')
      const wasQuickMaskMode = this.ps.isQuickMaskMode(doc)

      if (!wasQuickMaskMode) {
        const imageObj = await photoshop.imaging.getPixels(request)
        debugSelection('getPixelsWithoutQuickMask', {
          toggledQuickMask: false,
          requestBounds: request.sourceBounds || null,
          width: imageObj?.imageData?.width || null,
          height: imageObj?.imageData?.height || null,
          components: imageObj?.imageData?.components || null,
        })
        return imageObj
      }

      doc.quickMaskMode = false
      try {
        const imageObj = await photoshop.imaging.getPixels(request)
        debugSelection('getPixelsWithoutQuickMask', {
          toggledQuickMask: true,
          requestBounds: request.sourceBounds || null,
          width: imageObj?.imageData?.width || null,
          height: imageObj?.imageData?.height || null,
          components: imageObj?.imageData?.components || null,
        })
        return imageObj
      } finally {
        doc.quickMaskMode = true
      }
    }

    async resolveRequestBounds(layer, options = {}) {
      if (options.sourceBounds) {
        return { ...options.sourceBounds }
      }

      const layerBounds = await this.ps.getLayerBounds(layer)
      if (layerBounds) {
        return layerBounds
      }

      if (options.fallbackBounds) {
        return { ...options.fallbackBounds }
      }

      return null
    }

    toSourceBounds(bounds) {
      return {
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
        right: Math.round(bounds.right),
        bottom: Math.round(bounds.bottom),
      }
    }

    normalizeImagingBounds(bounds, width, height) {
      if (!bounds) {
        return {
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          width,
          height,
        }
      }

      const left = Math.round(bounds.left ?? 0)
      const top = Math.round(bounds.top ?? 0)
      const right = Math.round(bounds.right ?? left + width)
      const bottom = Math.round(bounds.bottom ?? top + height)
      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }
    }

    async buildCapturePayload(capture, { name, canvasBounds, targetSize, outputFormat = 'png', jpegQuality = 90 }) {
      return this.buildRawPayloadFromImageData(capture.imageData, {
        name,
        sourceBounds: capture.bounds,
        canvasBounds,
        targetSize,
        outputFormat,
        jpegQuality,
      })
    }

    async buildMaskPayload(capture, { name, canvasBounds, targetSize }) {
      const rawPixels = await this.composeSingleChannelCanvas(capture, canvasBounds)
      return this.buildRawPayloadFromBytes(rawPixels, {
        name,
        components: 1,
        sourceWidth: canvasBounds.width,
        sourceHeight: canvasBounds.height,
        canvasBounds,
        targetSize,
        outputFormat: 'png',
      })
    }

    async buildAlphaPayload(capture, { name, canvasBounds, targetSize }) {
      const rawPixels = await this.composeAlphaCanvas(capture, canvasBounds)
      if (!rawPixels) {
        return null
      }

      return this.buildRawPayloadFromBytes(rawPixels, {
        name,
        components: 1,
        sourceWidth: canvasBounds.width,
        sourceHeight: canvasBounds.height,
        canvasBounds,
        targetSize,
        outputFormat: 'png',
      })
    }

    async buildMaskedImagePayload(capture, selectionCapture, { name, canvasBounds, targetSize, preserveSourceAlpha }) {
      const imageCanvas = await this.composeImageCanvas(capture, canvasBounds, 4)
      const selectionCanvas = await this.composeSingleChannelCanvas(selectionCapture, canvasBounds)
      const pixelCount = canvasBounds.width * canvasBounds.height
      const rgba = new Uint8Array(pixelCount * 4)

      for (let index = 0; index < pixelCount; index += 1) {
        const rgbaOffset = index * 4
        const sourceAlpha = imageCanvas[rgbaOffset + 3]
        const selectionAlpha = selectionCanvas[index]

        rgba[rgbaOffset] = imageCanvas[rgbaOffset]
        rgba[rgbaOffset + 1] = imageCanvas[rgbaOffset + 1]
        rgba[rgbaOffset + 2] = imageCanvas[rgbaOffset + 2]
        rgba[rgbaOffset + 3] = preserveSourceAlpha
          ? Math.round((sourceAlpha * selectionAlpha) / 255)
          : selectionAlpha
      }

      return this.buildRawPayloadFromBytes(rgba, {
        name,
        components: 4,
        sourceWidth: canvasBounds.width,
        sourceHeight: canvasBounds.height,
        canvasBounds,
        targetSize,
        outputFormat: 'png',
      })
    }

    async buildRawPayloadFromImageData(
      photoshopImageData,
      {
        name = `capture_${Date.now()}.raw`,
        sourceBounds = null,
        canvasBounds = null,
        targetSize = null,
        outputFormat = 'png',
        jpegQuality = 90,
      } = {},
    ) {
      const pixelData = await photoshopImageData.getData({ chunky: true })
      return this.buildRawPayloadFromBytes(new Uint8Array(pixelData), {
        name,
        components: photoshopImageData.components,
        sourceWidth: photoshopImageData.width,
        sourceHeight: photoshopImageData.height,
        sourceBounds,
        canvasBounds: canvasBounds || sourceBounds || {
          left: 0,
          top: 0,
          right: photoshopImageData.width,
          bottom: photoshopImageData.height,
          width: photoshopImageData.width,
          height: photoshopImageData.height,
        },
        targetSize: targetSize || {
          width: photoshopImageData.width,
          height: photoshopImageData.height,
        },
        outputFormat,
        jpegQuality,
      })
    }

    buildRawPayloadFromBytes(
      rawPixels,
      {
        name = `capture_${Date.now()}.raw`,
        components = 4,
        sourceWidth,
        sourceHeight,
        sourceBounds = null,
        canvasBounds = null,
        targetSize = null,
        outputFormat = 'png',
        jpegQuality = 90,
      } = {},
    ) {
      const safeCanvasBounds = canvasBounds || sourceBounds || {
        left: 0,
        top: 0,
        right: sourceWidth,
        bottom: sourceHeight,
        width: sourceWidth,
        height: sourceHeight,
      }
      const safeTargetSize = targetSize || {
        width: safeCanvasBounds.width,
        height: safeCanvasBounds.height,
      }
      const safeSourceBounds = sourceBounds || {
        left: safeCanvasBounds.left,
        top: safeCanvasBounds.top,
        right: safeCanvasBounds.left + sourceWidth,
        bottom: safeCanvasBounds.top + sourceHeight,
        width: sourceWidth,
        height: sourceHeight,
      }

      return {
        rawPixels: rawPixels instanceof Uint8Array ? rawPixels : new Uint8Array(rawPixels),
        components,
        sourceWidth,
        sourceHeight,
        width: Math.max(1, Math.round(safeTargetSize.width)),
        height: Math.max(1, Math.round(safeTargetSize.height)),
        canvasWidth: Math.max(1, Math.round(safeCanvasBounds.width)),
        canvasHeight: Math.max(1, Math.round(safeCanvasBounds.height)),
        offsetX: Math.round(safeSourceBounds.left - safeCanvasBounds.left),
        offsetY: Math.round(safeSourceBounds.top - safeCanvasBounds.top),
        outputFormat,
        jpegQuality,
        format: 'raw',
        name,
      }
    }

    async composeImageCanvas(capture, canvasBounds, targetComponents = 4) {
      const rawPixels = await this.readCapturePixels(capture)
      const sourceWidth = capture.imageData.width
      const sourceHeight = capture.imageData.height
      const sourceComponents = capture.components || capture.imageData.components || 4
      const canvasWidth = canvasBounds.width
      const canvasHeight = canvasBounds.height
      const offsetX = capture.bounds.left - canvasBounds.left
      const offsetY = capture.bounds.top - canvasBounds.top
      const canvasPixels = new Uint8Array(canvasWidth * canvasHeight * targetComponents)

      for (let y = 0; y < sourceHeight; y += 1) {
        for (let x = 0; x < sourceWidth; x += 1) {
          const destX = x + offsetX
          const destY = y + offsetY
          if (destX < 0 || destX >= canvasWidth || destY < 0 || destY >= canvasHeight) {
            continue
          }

          const srcIndex = (y * sourceWidth + x) * sourceComponents
          const dstIndex = (destY * canvasWidth + destX) * targetComponents

          if (sourceComponents === 1) {
            const value = rawPixels[srcIndex]
            canvasPixels[dstIndex] = value
            canvasPixels[dstIndex + 1] = value
            canvasPixels[dstIndex + 2] = value
            if (targetComponents === 4) canvasPixels[dstIndex + 3] = 255
          } else if (sourceComponents === 2) {
            const value = rawPixels[srcIndex]
            const alpha = rawPixels[srcIndex + 1]
            canvasPixels[dstIndex] = value
            canvasPixels[dstIndex + 1] = value
            canvasPixels[dstIndex + 2] = value
            if (targetComponents === 4) canvasPixels[dstIndex + 3] = alpha
          } else {
            canvasPixels[dstIndex] = rawPixels[srcIndex]
            canvasPixels[dstIndex + 1] = rawPixels[srcIndex + 1]
            canvasPixels[dstIndex + 2] = rawPixels[srcIndex + 2]
            if (targetComponents === 4) {
              canvasPixels[dstIndex + 3] = sourceComponents >= 4 ? rawPixels[srcIndex + 3] : 255
            }
          }
        }
      }

      return canvasPixels
    }

    async composeSingleChannelCanvas(capture, canvasBounds) {
      const rawPixels = await this.readCapturePixels(capture)
      const sourceWidth = capture.imageData.width
      const sourceHeight = capture.imageData.height
      const sourceComponents = capture.components || capture.imageData.components || 1
      const canvasWidth = canvasBounds.width
      const canvasHeight = canvasBounds.height
      const offsetX = capture.bounds.left - canvasBounds.left
      const offsetY = capture.bounds.top - canvasBounds.top
      const canvasPixels = new Uint8Array(canvasWidth * canvasHeight)

      for (let y = 0; y < sourceHeight; y += 1) {
        for (let x = 0; x < sourceWidth; x += 1) {
          const destX = x + offsetX
          const destY = y + offsetY
          if (destX < 0 || destX >= canvasWidth || destY < 0 || destY >= canvasHeight) {
            continue
          }

          const srcIndex = (y * sourceWidth + x) * sourceComponents
          const dstIndex = destY * canvasWidth + destX
          let value = sourceComponents === 1
            ? rawPixels[srcIndex]
            : rawPixels[srcIndex + sourceComponents - 1]
          if (capture.selectionPolarity === 'low') {
            value = 255 - value
          }
          canvasPixels[dstIndex] = value
        }
      }

      return canvasPixels
    }

    async composeAlphaCanvas(capture, canvasBounds) {
      const sourceComponents = capture.components || capture.imageData.components || 4
      if (sourceComponents !== 2 && sourceComponents < 4) {
        return null
      }

      return this.composeSingleChannelCanvas(capture, canvasBounds)
    }

    async readCapturePixels(capture) {
      if (capture?._rawPixels instanceof Uint8Array) {
        return capture._rawPixels
      }

      const pixelData = await capture.imageData.getData({ chunky: true })
      const rawPixels = new Uint8Array(pixelData)
      if (capture && typeof capture === 'object') {
        capture._rawPixels = rawPixels
      }
      return rawPixels
    }

    async toRgbaPixels(capture) {
      const rawPixels = await this.readCapturePixels(capture)
      const width = capture.imageData.width
      const height = capture.imageData.height
      const sourceComponents = capture.components || capture.imageData.components || 4
      const rgba = new Uint8Array(width * height * 4)

      for (let index = 0; index < width * height; index += 1) {
        const srcIndex = index * sourceComponents
        const dstIndex = index * 4

        if (sourceComponents === 1) {
          const value = rawPixels[srcIndex]
          rgba[dstIndex] = value
          rgba[dstIndex + 1] = value
          rgba[dstIndex + 2] = value
          rgba[dstIndex + 3] = 255
          continue
        }

        if (sourceComponents === 2) {
          const value = rawPixels[srcIndex]
          rgba[dstIndex] = value
          rgba[dstIndex + 1] = value
          rgba[dstIndex + 2] = value
          rgba[dstIndex + 3] = rawPixels[srcIndex + 1]
          continue
        }

        rgba[dstIndex] = rawPixels[srcIndex]
        rgba[dstIndex + 1] = rawPixels[srcIndex + 1]
        rgba[dstIndex + 2] = rawPixels[srcIndex + 2]
        rgba[dstIndex + 3] = sourceComponents >= 4 ? rawPixels[srcIndex + 3] : 255
      }

      return rgba
    }

    async toSingleChannelPixels(capture) {
      const rawPixels = await this.readCapturePixels(capture)
      const width = capture.imageData.width
      const height = capture.imageData.height
      const sourceComponents = capture.components || capture.imageData.components || 1
      const single = new Uint8Array(width * height)

      for (let index = 0; index < width * height; index += 1) {
        const srcIndex = index * sourceComponents
        let value = sourceComponents === 1
          ? rawPixels[srcIndex]
          : rawPixels[srcIndex + sourceComponents - 1]
        if (capture.selectionPolarity === 'low') {
          value = 255 - value
        }
        single[index] = value
      }

      return single
    }

    async computeSingleChannelContentBounds(capture, { polarity = 'high' } = {}) {
      if (!capture?.imageData || !capture?.bounds) {
        return null
      }

      const rawPixels = await this.readCapturePixels(capture)
      const width = capture.imageData.width
      const height = capture.imageData.height
      const sourceComponents = capture.components || capture.imageData.components || 1
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * sourceComponents
          const value = sourceComponents === 1
            ? rawPixels[index]
            : rawPixels[index + sourceComponents - 1]
          const isSelected = polarity === 'low' ? value < 255 : value > 0
          if (!isSelected) {
            continue
          }

          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }

      if (maxX < minX || maxY < minY) {
        return null
      }

      const left = capture.bounds.left + minX
      const top = capture.bounds.top + minY
      const right = capture.bounds.left + maxX + 1
      const bottom = capture.bounds.top + maxY + 1
      return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      }
    }

    resolveSelectionCandidateBounds({ rawBounds, positiveBounds, negativeBounds, expectedBounds = null }) {
      const candidates = [
        { polarity: 'high', bounds: positiveBounds },
        { polarity: 'low', bounds: negativeBounds },
      ].filter((candidate) => candidate.bounds && candidate.bounds.width > 0 && candidate.bounds.height > 0)

      if (!candidates.length) {
        return { polarity: 'high', bounds: null }
      }

      if (expectedBounds && expectedBounds.width > 0 && expectedBounds.height > 0) {
        let bestCandidate = candidates[0]
        let bestScore = -1

        for (const candidate of candidates) {
          const score = this.computeBoundsMatchScore(candidate.bounds, expectedBounds)
          if (score > bestScore) {
            bestScore = score
            bestCandidate = candidate
          }
        }

        return bestCandidate
      }

      if (rawBounds?.width > 0 && rawBounds?.height > 0) {
        const rawArea = rawBounds.width * rawBounds.height
        const fullThreshold = 0.985
        const enriched = candidates.map((candidate) => ({
          ...candidate,
          area: candidate.bounds.width * candidate.bounds.height,
          fillRatio: (candidate.bounds.width * candidate.bounds.height) / rawArea,
        }))

        const nonFullCandidates = enriched.filter((candidate) => candidate.fillRatio < fullThreshold)
        const fullCandidates = enriched.filter((candidate) => candidate.fillRatio >= fullThreshold)

        if (nonFullCandidates.length === 1 && fullCandidates.length >= 1) {
          return nonFullCandidates[0]
        }

        if (enriched.length === 2) {
          const [first, second] = enriched
          const smaller = first.area <= second.area ? first : second
          const larger = first.area > second.area ? first : second
          if (larger.area / Math.max(1, smaller.area) >= 1.8) {
            return smaller
          }
        }
      }

      return candidates[0]
    }

    computeBoundsMatchScore(bounds, expectedBounds) {
      const overlap = this.ps.intersectBounds(bounds, expectedBounds)
      if (!overlap) {
        return 0
      }

      const overlapArea = overlap.width * overlap.height
      const boundsArea = Math.max(1, bounds.width * bounds.height)
      const expectedArea = Math.max(1, expectedBounds.width * expectedBounds.height)
      const precision = overlapArea / boundsArea
      const recall = overlapArea / expectedArea
      return precision * 0.55 + recall * 0.45
    }

    disposeCapture(capture) {
      if (capture && typeof capture === 'object' && capture._rawPixels) {
        delete capture._rawPixels
      }
      capture?.imageData?.dispose?.()
    }
  }

  global.TunanCaptureService = TunanCaptureService
})(window)
