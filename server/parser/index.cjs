// STUB — the full Whatnot-PDF parser is written by the parser agent.
// Contract (must be preserved by the implementation):
//   async parsePdf(buffer, { onProgress }) -> dataset
//   where `dataset` matches the shape consumed by db.importDataset (see db.cjs).
module.exports = {
  async parsePdf() {
    throw new Error('PDF parser not yet implemented')
  },
}
