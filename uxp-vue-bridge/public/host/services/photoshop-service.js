(function initTunanPhotoshopService(global) {
  class TunanPhotoshopService {
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

    async exportSelectionCapture(doc, settings, { captureMode = 'merged', layerBoundaryMode = 'document' } = {}) {
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

      const image = await this.exportSelectionVariant(doc, settings, {
        captureMode,
        sendBounds,
        targetSize,
        selectionOnly: selectionSendMode === 'shape',
        fileStem: `selection_${selectionSendMode}_${Date.now()}`,
        forcedFormat: selectionSendMode === 'shape' || captureMode === 'current' ? 'png' : null,
      })

      const selectionMask =
        selectionSendMode === 'rect'
          ? await this.exportSelectionVariant(doc, settings, {
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

    async exportCurrentLayerContent(doc, settings) {
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

    async exportCurrentLayerDocument(doc, settings) {
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

    async exportMergedDocument(doc, settings) {
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

    async exportSelectionVariant(
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

    async getSelectionBounds(doc) {
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

        const selection = result[0]?.selection
        if (!selection) return null

        const bounds = {
          left: Math.floor(selection.left._value || selection.left),
          top: Math.floor(selection.top._value || selection.top),
          right: Math.ceil(selection.right._value || selection.right),
          bottom: Math.ceil(selection.bottom._value || selection.bottom),
        }

        bounds.width = bounds.right - bounds.left
        bounds.height = bounds.bottom - bounds.top
        return bounds.width > 0 && bounds.height > 0 ? bounds : null
      } catch {
        return null
      }
    }

    async getLayerBounds(layer) {
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
      const scaleMode = settings.scaleMode || 'limit'
      const currentEdge = edgeControl === 'short' ? Math.min(sourceWidth, sourceHeight) : Math.max(sourceWidth, sourceHeight)

      if (scaleMode === 'limit' && currentEdge <= targetEdge) {
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
      return Number(value || 0)
    }

    async addImageToDocument(payload = {}) {
      const imageData = payload.image
      if (!imageData) {
        throw new Error('没有可导回 Photoshop 的图像')
      }

      const placement = payload.placement || payload.meta?.placement || null
      const imageInfo = {
        image: imageData,
        placement,
        name: payload.meta?.name || '图南画桥结果',
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
              name: '图南画桥结果',
            })
          }

          const tempFolder = await fs.getTemporaryFolder()
          const extension = imageData.includes('image/jpeg') ? 'jpg' : 'png'
          const tempFile = await tempFolder.createFile(`tunan_return_${Date.now()}.${extension}`, {
            overwrite: true,
          })
          await tempFile.write(this.dataUrlToArrayBuffer(imageData))

          const token = await fs.createSessionToken(tempFile)

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

          const placedLayer = doc.activeLayers[0]
          if (placedLayer) {
            placedLayer.name = imageInfo.name
            const currentBounds = await this.getLayerBounds(placedLayer)
            const targetBounds =
              placement?.selectionBounds ||
              placement?.layerBounds ||
              placement?.documentBounds ||
              null

            if (currentBounds && targetBounds) {
              await this.transformLayer(placedLayer, currentBounds, targetBounds)
            }
          }

          try {
            await tempFile.delete()
          } catch {}

          return {
            supported: true,
            placed: true,
            name: imageInfo.name,
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
