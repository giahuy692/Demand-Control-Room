USE [3PPOS]
GO
/****** Object:  StoredProcedure [dbo].[sp_Stock]    Script Date: 7/13/2026 3:57:00 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
ALTER PROCEDURE [dbo].[sp_Stock]
(
@Type int,
@MasterID int
)
AS
BEGIN
	SET NOCOUNT ON;
	IF(@Type=1)
	BEGIN
		INSERT INTO dbo.tbl_INInventoryStock
		(Barcode, MasterID, ProductID, Quantity, LastQuantity, CreateBy, CreateTime)
		SELECT Barcode, @MasterID, Code, 0, 0, 'sys', GETDATE() FROM VHC_Management.dbo.tbl_LSProduct
		WHERE Barcode not in (SELECT Barcode FROM tbl_INInventoryStock WHERE MasterID=@MasterID)
			and GroupID not like '002%' and DsPosCode is not null and LEN(DsPosCode)>4
	END
	ELSE IF(@Type=2)
	BEGIN
	;WITH B AS
	(SELECT Code, Barcode, Quantity from VHC_Management.dbo.tbl_LSProduct where Quantity is not null and DsPosCode is not null and LEN(DsPosCode)>4)
	
		
		UPDATE dbo.tbl_INInventoryStock
		SET Quantity=B.Quantity
		FROM B
		WHERE tbl_INInventoryStock.Barcode=B.Barcode and [MasterID]=@MasterID
	END
END
